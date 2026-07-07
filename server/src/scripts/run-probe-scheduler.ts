// P3 probe-bank scheduling — the third of Adam's three cadences: not
// realtime (quota harvest) and not weekly (research cron), but EVENT-DRIVEN
// on model/capability change detection. Two real triggers, both already
// exist in the system, neither was previously acted on:
//
// 1. suspect=true rows — set by the L9 runtime-feedback loop (proxy.ts) the
//    moment a production call proves a measured capability regressed. This
//    is the highest-priority queue: a live request already failed because
//    of this.
// 2. never-probed models — a model with a configured key but zero measured
//    rows for tools/json_mode. Catches new models Adam adds via the UI, or
//    models the initial probe sweep simply hasn't reached yet.
//
// "Event-driven, not fixed-interval" describes the TRIGGER, not this
// script's own invocation — there's no push notification when a suspect row
// appears or a new key is added, so this script is the poll mechanism that
// discovers those events promptly. Intended to be invoked periodically
// (systemd timer / cron), but that persistent scheduling is a separate,
// explicit decision from writing the mechanism itself — this script is
// safe to run standalone any time with `npx tsx src/scripts/run-probe-scheduler.ts`.
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, get } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { recordProbeResult, getSuspectCapabilities, type ProbeContext } from '../services/probes/runner.js';
import { probeTools, probeJsonMode } from '../services/probes/methods.js';

const DELAY_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function contextFor(platform: string, modelDbId: number): Promise<ProbeContext | null> {
  const pool = getPool();
  const keyRow = await get<{ encrypted_key: string; iv: string; auth_tag: string }>(pool,
    `SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = true AND status != 'invalid' LIMIT 1`,
    [platform]
  );
  const modelRow = await get<{ model_id: string }>(pool, `SELECT model_id FROM models WHERE id = ?`, [modelDbId]);
  const provider = getProvider(platform as any);
  if (!keyRow || !modelRow || !provider) return null;
  return { provider, apiKey: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag), modelId: modelRow.model_id, modelDbId, platform };
}

async function runProbeFor(capability: string, ctx: ProbeContext): Promise<{ passed: boolean; transient?: boolean }> {
  if (capability === 'tools') {
    const r = await probeTools(ctx);
    await recordProbeResult('tools', ctx, r, false);
    return r;
  }
  if (capability === 'json_mode') {
    const r = await probeJsonMode(ctx);
    await recordProbeResult('json_mode', ctx, r, false);
    return r;
  }
  throw new Error(`No probe method wired for capability '${capability}' — scheduler currently covers tools/json_mode only`);
}

async function main() {
  await initDb();
  const pool = getPool();

  console.log('=== Priority 1: suspect-flagged capabilities (production-proven regressions) ===');
  const suspects = await getSuspectCapabilities();
  for (const s of suspects) {
    const ctx = await contextFor(s.platform, s.modelDbId);
    if (!ctx) {
      console.log(`[${s.platform}/${s.modelId}] ${s.capability}: no key/provider available, skipping`);
      continue;
    }
    try {
      const result = await runProbeFor(s.capability, ctx);
      console.log(`[${s.platform}/${s.modelId}] ${s.capability} re-probe: ${result.passed ? 'CONFIRMED STILL WORKS' : result.transient ? 'SKIPPED (transient)' : 'CONFIRMED REGRESSED'}`);
    } catch (err: any) {
      console.log(`[${s.platform}/${s.modelId}] ${s.capability} re-probe ERROR: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
  if (suspects.length === 0) console.log('(none)');

  console.log('\n=== Priority 2: never-probed models (have a key, zero measured tools/json_mode data) ===');
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
    const ctx = await contextFor(m.platform, m.id);
    if (!ctx) continue;
    for (const capability of ['tools', 'json_mode']) {
      try {
        const result = await runProbeFor(capability, ctx);
        console.log(`[${m.platform}/${m.model_id}] ${capability}: ${result.passed ? 'PASS' : result.transient ? 'SKIPPED (transient)' : 'FAIL'}`);
      } catch (err: any) {
        console.log(`[${m.platform}/${m.model_id}] ${capability} ERROR: ${err.message}`);
      }
      await sleep(DELAY_MS);
    }
  }
  if (neverProbed.length === 0) console.log('(none)');

  await closeDb();
}

main().catch((err) => {
  console.error('Probe scheduler run failed:', err);
  process.exit(1);
});
