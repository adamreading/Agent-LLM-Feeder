import type pg from 'pg';
import { all, get } from '../../db/pgCompat.js';
import { getProvider } from '../../providers/index.js';
import { decrypt } from '../../lib/crypto.js';
import { recordProbeResult, getSuspectCapabilities, type ProbeContext } from './runner.js';
import { probeTools, probeJsonMode } from './methods.js';

// Shared event-driven probe logic (used by the CLI scheduler script AND the
// auto-onboard-on-arrival path). Two triggers: production-proven regressions
// (suspect=true, set by the L9 runtime feedback loop) and never-probed keyed
// models (new arrivals / gaps the initial sweep didn't reach). Idempotent —
// once a model has measured tools/json_mode rows it stops qualifying, so
// steady state is a no-op.

const DELAY_MS = Number(process.env.PROBE_DELAY_MS) || 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Logger = (msg: string) => void;

export async function contextFor(pool: pg.Pool, platform: string, modelDbId: number): Promise<ProbeContext | null> {
  const keyRow = await get<{ encrypted_key: string; iv: string; auth_tag: string }>(pool,
    `SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = true AND status != 'invalid' LIMIT 1`, [platform]);
  const modelRow = await get<{ model_id: string }>(pool, `SELECT model_id FROM models WHERE id = ?`, [modelDbId]);
  const provider = getProvider(platform as any);
  if (!keyRow || !modelRow || !provider) return null;
  return { provider, apiKey: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag), modelId: modelRow.model_id, modelDbId, platform };
}

async function runProbeFor(capability: string, ctx: ProbeContext): Promise<{ passed: boolean; transient?: boolean }> {
  if (capability === 'tools') { const r = await probeTools(ctx); await recordProbeResult('tools', ctx, r, false); return r; }
  if (capability === 'json_mode') { const r = await probeJsonMode(ctx); await recordProbeResult('json_mode', ctx, r, false); return r; }
  throw new Error(`No probe method wired for capability '${capability}'`);
}

export async function reprobeSuspects(pool: pg.Pool, log: Logger = () => {}): Promise<number> {
  const suspects = await getSuspectCapabilities();
  for (const s of suspects) {
    const ctx = await contextFor(pool, s.platform, s.modelDbId);
    if (!ctx) { log(`[${s.platform}/${s.modelId}] ${s.capability}: no key/provider, skip`); continue; }
    try {
      const r = await runProbeFor(s.capability, ctx);
      log(`[${s.platform}/${s.modelId}] ${s.capability} re-probe: ${r.passed ? 'STILL WORKS' : r.transient ? 'SKIPPED (transient)' : 'REGRESSED'}`);
    } catch (err: any) { log(`[${s.platform}/${s.modelId}] ${s.capability} re-probe ERROR: ${err.message}`); }
    await sleep(DELAY_MS);
  }
  return suspects.length;
}

export async function probeNeverProbed(pool: pg.Pool, log: Logger = () => {}): Promise<number> {
  const neverProbed = await all<{ id: number; platform: string; model_id: string }>(pool, `
    SELECT m.id, m.platform, m.model_id
    FROM models m
    JOIN api_keys k ON k.platform = m.platform AND k.enabled = true AND k.status != 'invalid'
    WHERE m.enabled = true
      AND NOT EXISTS (
        SELECT 1 FROM model_capabilities mc
        WHERE mc.model_db_id = m.id AND mc.source = 'measured' AND mc.capability IN ('tools', 'json_mode')
      )
    ORDER BY m.platform, m.model_id
  `);
  for (const m of neverProbed) {
    const ctx = await contextFor(pool, m.platform, m.id);
    if (!ctx) continue;
    for (const capability of ['tools', 'json_mode']) {
      try {
        const r = await runProbeFor(capability, ctx);
        log(`[${m.platform}/${m.model_id}] ${capability}: ${r.passed ? 'PASS' : r.transient ? 'SKIPPED (transient)' : 'FAIL'}`);
      } catch (err: any) { log(`[${m.platform}/${m.model_id}] ${capability} ERROR: ${err.message}`); }
      await sleep(DELAY_MS);
    }
  }
  return neverProbed.length;
}
