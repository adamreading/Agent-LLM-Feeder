import type pg from 'pg';
import { all, get, run } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { logProbeRequest } from './probes/runner.js';
import type { Platform } from '@freellmapi/shared/types.js';

// Cheap liveness re-check (Adam, 2026-07-11): "I don't mind a health probe, I
// just don't want to burn tokens." The heavy capability sweeps (long-context
// needle tests) are banned; THIS is the sanctioned opposite — a max_tokens=1
// "ping" (a few tokens total) to see whether a model that was auto-benched on a
// transient 403/404 has come back, and revive it if so.
//
// SCOPE: reason='unreachable' ONLY — models benched at runtime by
// benchUnreachableModel (a real 403/404 on live traffic). Deliberately NOT
// 'unavailable'/'paid_tier' (those were disabled by catalog-curation migrations
// that re-run `enabled=false` unconditionally every startup — reviving them
// would just fight the migration on the next restart, the L12 delete/re-insert
// war). 'no_key' is platformKeyWatch's job; 'unhealthy' is modelHealth's.
//
// Bounded: at most MAX_PER_RUN models per pass, oldest-checked first, one tiny
// call each. Each call is logged is_probe=true so it shows in the token budget
// dashboard and never pollutes quality/latency scoring.

const MAX_PER_RUN = 6;
const PING_MESSAGES = [{ role: 'user' as const, content: 'ping' }];

export async function recheckUnreachableModels(pool: pg.Pool): Promise<{ checked: number; revived: string[] }> {
  const rows = await all<{ id: number; platform: string; model_id: string; display_name: string }>(pool, `
    SELECT m.id, m.platform, m.model_id, m.display_name
    FROM models m
    WHERE m.enabled = false AND m.disabled_reason = 'unreachable'
      AND EXISTS (SELECT 1 FROM api_keys k WHERE k.platform = m.platform AND k.enabled = true AND k.status != 'invalid')
    ORDER BY m.updated_at ASC NULLS FIRST
    LIMIT ?
  `, [MAX_PER_RUN]);

  const revived: string[] = [];
  for (const m of rows) {
    const provider = getProvider(m.platform as Platform);
    if (!provider) continue;
    const keyRow = await get<{ encrypted_key: string; iv: string; auth_tag: string }>(pool,
      `SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = true AND status != 'invalid' LIMIT 1`,
      [m.platform]);
    if (!keyRow) continue;

    const started = Date.now();
    try {
      const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
      const res = await provider.chatCompletion(apiKey, PING_MESSAGES, m.model_id, { max_tokens: 1, temperature: 0 });
      const ok = !!res?.choices?.length;
      await logProbeRequest(m.platform, m.model_id, ok ? 'success' : 'error', 1, res?.usage?.completion_tokens ?? 0, Date.now() - started, ok ? null : 'liveness: empty response');
      if (ok) {
        // Revive ONLY if still unreachable (guard against a concurrent change).
        await run(pool, `UPDATE models SET enabled = true, disabled_reason = NULL, updated_at = now() WHERE id = ? AND enabled = false AND disabled_reason = 'unreachable'`, [m.id]);
        revived.push(`${m.platform}/${m.model_id}`);
        console.log(`[Liveness] revived ${m.display_name} — responded 200 to a max_tokens=1 ping`);
      } else {
        await run(pool, `UPDATE models SET updated_at = now() WHERE id = ?`, [m.id]); // bump so it rotates to the back
      }
    } catch (err: any) {
      // Still down — leave benched, bump updated_at so it rotates.
      await logProbeRequest(m.platform, m.model_id, 'error', 1, 0, Date.now() - started, `liveness: ${String(err?.message ?? err).slice(0, 80)}`);
      await run(pool, `UPDATE models SET updated_at = now() WHERE id = ?`, [m.id]).catch(() => {});
    }
  }
  return { checked: rows.length, revived };
}
