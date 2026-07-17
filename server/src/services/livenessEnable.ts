import type pg from 'pg';
import { all, get, run } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { logProbeRequest } from './probes/runner.js';
import type { Platform } from '@freellmapi/shared/types.js';

// Liveness-enable pass over `pending-liveness` models: a newly-discovered model
// enters the catalog disabled (enabled=false, disabled_reason='pending-liveness…')
// so it can't route or clutter the wiki until proven. This does the proving —
// ONE small real completion per model:
//   WORKS      → enabled=true, disabled_reason=NULL (+ a healthy model_health row)
//   PAID       → stay disabled, disabled_reason='paid_tier'
//   DEAD/404   → stay disabled, disabled_reason='unavailable' (a 2nd retire signal)
//   transient  → stay pending (retried next run)
//   no key/provider → stay pending
//
// This is the sanctioned cheap-probe class (Adam, 2026-07-11: "I don't mind a
// health probe, I just don't want to burn tokens"): BOUNDED to `limit` models
// per pass and each call is logged is_probe=true so the spend shows on the token
// dashboard and never pollutes quality/latency scoring. The daily catalogSync
// caps this so a burst of new provider ids can't spike token spend in one run.
//
// Regexes mirror scripts/liveness-enable.ts (the manual equivalent).

const PAID_RE = /subscription|payment|402|insufficient|balance|unavailable for free|paid version|requires? (a )?(pro|paid|subscription)|billing|purchase|upgrade/i;
const DEAD_RE = /\b404\b|not found|no endpoints|does not exist|unknown model|no such model|model_not_found|invalid model|not a valid model|decommission|deprecated/i;

export interface LivenessEnableResult {
  checked: number;
  enabled: string[];
  paid: number;
  dead: number;
  transient: number;
  nokey: number;
}

export async function livenessEnablePending(
  pool: pg.Pool,
  opts: { limit?: number; log?: (m: string) => void } = {}
): Promise<LivenessEnableResult> {
  const log = opts.log ?? (() => {});
  const limit = Math.max(0, Math.floor(opts.limit ?? 15));
  const res: LivenessEnableResult = { checked: 0, enabled: [], paid: 0, dead: 0, transient: 0, nokey: 0 };
  if (limit === 0) return res;

  // Only models we hold a usable key for — can't liveness-test what we can't call.
  const pending = await all<{ id: number; platform: string; model_id: string; display_name: string }>(pool, `
    SELECT m.id, m.platform, m.model_id, m.display_name
    FROM models m
    WHERE m.enabled = false AND m.disabled_reason LIKE 'pending-liveness%' AND m.kind = 'chat'
      AND EXISTS (SELECT 1 FROM api_keys k WHERE k.platform = m.platform AND k.enabled = true AND k.status != 'invalid')
    ORDER BY m.id ASC
    LIMIT ?
  `, [limit]);

  const keyCache = new Map<string, string | null>();
  const keyFor = async (platform: string): Promise<string | null> => {
    if (keyCache.has(platform)) return keyCache.get(platform)!;
    const k = await get<{ encrypted_key: string; iv: string; auth_tag: string }>(pool,
      `SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = true AND status != 'invalid' LIMIT 1`, [platform]);
    let v: string | null = null;
    if (k) { try { v = decrypt(k.encrypted_key, k.iv, k.auth_tag); } catch { v = null; } }
    keyCache.set(platform, v);
    return v;
  };

  for (const m of pending) {
    res.checked++;
    const provider = getProvider(m.platform as Platform);
    const apiKey = await keyFor(m.platform);
    if (!provider || !apiKey) { res.nokey++; continue; }

    const started = Date.now();
    try {
      const resp = await provider.chatCompletion(apiKey, [{ role: 'user', content: 'Reply with the single word: ok' }], m.model_id, { max_tokens: 300, temperature: 0 });
      const lat = Date.now() - started;
      const content = resp?.choices?.[0]?.message?.content;
      const ok = (typeof content === 'string' && content.trim().length > 0) || !!resp?.choices?.length;
      await logProbeRequest(m.platform, m.model_id, ok ? 'success' : 'error', 1, resp?.usage?.completion_tokens ?? 0, lat, ok ? null : 'liveness-enable: empty');
      // Enable only if still pending (guard against a concurrent change).
      await run(pool, `UPDATE models SET enabled = true, disabled_reason = NULL WHERE id = ? AND enabled = false AND disabled_reason LIKE 'pending-liveness%'`, [m.id]);
      await run(pool, `INSERT INTO model_health (model_db_id, recent_latency_ms, status, updated_at) VALUES (?, ?, 'healthy', now()) ON CONFLICT (model_db_id) DO UPDATE SET recent_latency_ms = EXCLUDED.recent_latency_ms, status = 'healthy', updated_at = now()`, [m.id, lat > 0 ? lat : null]);
      res.enabled.push(`${m.platform}/${m.model_id}`);
      log(`enabled ${m.platform}/${m.model_id} (${lat}ms)`);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      await logProbeRequest(m.platform, m.model_id, 'error', 1, 0, Date.now() - started, `liveness-enable: ${msg.slice(0, 80)}`);
      if (PAID_RE.test(msg)) {
        res.paid++;
        // Self-correct the cost label: a model that answers "payment required" is
        // paid, not the 'free' default the insert gave it — so it never routes as free.
        await run(pool, `UPDATE models SET disabled_reason = 'paid_tier', cost_tier = 'paid' WHERE id = ? AND enabled = false AND disabled_reason LIKE 'pending-liveness%'`, [m.id]);
        log(`paid ${m.platform}/${m.model_id}`);
      } else if (DEAD_RE.test(msg)) {
        res.dead++;
        await run(pool, `UPDATE models SET disabled_reason = 'unavailable' WHERE id = ? AND enabled = false AND disabled_reason LIKE 'pending-liveness%'`, [m.id]);
        log(`dead ${m.platform}/${m.model_id}`);
      } else {
        // 429 / timeout / 5xx — leave pending for a later retry.
        res.transient++;
      }
    }
  }
  return res;
}
