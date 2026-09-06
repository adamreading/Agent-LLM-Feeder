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
// Probe backoff: a transient probe outcome (timeout/429/5xx) records NO measured
// row (runner.recordProbeResult bails on transient), so a model that always
// times out stays "never probed" and would be re-probed on EVERY autoOnboard run
// (which fires at each server start) — burning ~15s per attempt on a dead model.
// So skip a model that has already failed >= N probe attempts in the last H
// hours; it's retried once the window lapses (a genuinely-transient model
// recovers). Defaults 2 fails / 24h.
const PROBE_FAIL_BACKOFF_N = Number(process.env.PROBE_FAIL_BACKOFF_N) || 2;
const PROBE_BACKOFF_HOURS = Number(process.env.PROBE_FAIL_BACKOFF_HOURS) || 24;
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

// BOUNDED per call (opts.limit). Unbounded until 2026-09-06: the moment
// enable-on-discovery flipped ~200 models to enabled=true, the next boot fired
// 264 real probe completions across 132 models (tools + json_mode each) — the
// exact probe-burst class Adam banned ("no more probes, they are using up all my
// tokens"), and the same defect the research cap below in autoOnboard fixed
// on 2026-07-17. Each probe IS useful (a measured tools row makes a model
// eligible for tool-armed requests), so cap it, don't remove it; the backlog
// drains a slice per boot.
export async function probeNeverProbed(pool: pg.Pool, log: Logger = () => {}, opts: { limit?: number } = {}): Promise<number> {
  const limit = Math.max(0, Math.floor(opts.limit ?? 20));
  if (limit === 0) return 0;
  const neverProbed = await all<{ id: number; platform: string; model_id: string }>(pool, `
    SELECT DISTINCT m.id, m.platform, m.model_id
    FROM models m
    JOIN api_keys k ON k.platform = m.platform AND k.enabled = true AND k.status != 'invalid'
    WHERE m.enabled = true
      AND NOT EXISTS (
        SELECT 1 FROM model_capabilities mc
        WHERE mc.model_db_id = m.id AND mc.source = 'measured' AND mc.capability IN ('tools', 'json_mode')
      )
      -- Backoff: skip a model that has already failed >= N probe attempts in the
      -- last H hours (it keeps timing out; don't re-burn ~15s on it every start).
      AND (
        SELECT count(*) FROM requests r
        WHERE r.platform = m.platform AND r.model_id = m.model_id
          AND r.is_probe = true AND r.status = 'error'
          AND r.created_at > now() - make_interval(hours => ?)
      ) < ?
      -- Don't probe a model that's currently quota-parked or circuit-broken —
      -- it'll just fail and add to the backoff for no information gain.
      AND NOT EXISTS (
        SELECT 1 FROM model_health h WHERE h.model_db_id = m.id
          AND (h.quota_exhausted_until > now() OR h.cooldown_until > now())
      )
    ORDER BY m.platform, m.model_id
    LIMIT ?
  `, [PROBE_BACKOFF_HOURS, PROBE_FAIL_BACKOFF_N, limit]);
  if (neverProbed.length === limit) log(`never-probed backlog is larger than this boot's cap (${limit}); the rest drains on later boots`);
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
