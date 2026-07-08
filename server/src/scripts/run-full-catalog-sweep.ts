// Adam's morning directive (2026-07-08, one-off authorized run, distinct
// from the persistent-scheduling standing-auth question which stays held):
// full probe across every model on every currently-keyed platform (7
// suppliers, ~56 enabled models). Per model: REACHABILITY (explicit
// true/false, never left ambiguous), CAPABILITIES (tools/json_mode/
// long_context, all source=measured, reasoning_control only where a
// provider actually declares a dialect), and a generic, use-case-neutral
// BEST-USE taxonomy that feeds Adam's own intelligence/budget/speed scoring
// — explicitly NOT Hermes-specific (same agnosticism principle as the
// router refactor). ob_readwrite is deliberately NOT covered here — that
// dimension is Hermes-specific and is being built as a separate prober in
// hermes-stack (wsl-claude), writing to feeder's generic POST /capabilities
// endpoint instead of living in this sweep.
//
// Best-use tags are DERIVED, never fabricated: fast_chat/long_context/
// heavy_reasoning/tool_use come from real measured probes or from the
// catalog's own pre-existing curated size_label/speed_rank (which Adam's
// routing has trusted all along) — never a new judgment call invented
// under time pressure. 'coding' is explicitly a weaker, catalog-name-based
// heuristic (evidence says so) since there's no real coding-eval probe
// built yet — labeled honestly rather than oversold as measured rigor.
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, get, run } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { recordProbeResult, logProbeRequest, type ProbeContext, type ProbeOutcome } from '../services/probes/runner.js';
import { probeTools, probeJsonMode, probeLongContext } from '../services/probes/methods.js';

const DELAY_MS = 1800;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  speed_rank: number;
  intelligence_rank: number;
  size_label: string;
  context_window: number | null;
}

async function contextFor(platform: string, model: ModelRow): Promise<ProbeContext | null> {
  const pool = getPool();
  const keyRow = await get<{ encrypted_key: string; iv: string; auth_tag: string }>(pool,
    `SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = true AND status != 'invalid' LIMIT 1`,
    [platform]
  );
  const provider = getProvider(platform as any);
  if (!keyRow || !provider) return null;
  return { provider, apiKey: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag), modelId: model.model_id, modelDbId: model.id, platform };
}

async function checkReachable(ctx: ProbeContext): Promise<{ reachable: boolean; transient: boolean; evidence: string }> {
  const start = Date.now();
  try {
    const result = await ctx.provider.chatCompletion(ctx.apiKey, [{ role: 'user', content: 'hi' }], ctx.modelId, { max_tokens: 5 });
    void logProbeRequest(ctx.platform, ctx.modelId, 'success', result.usage?.prompt_tokens ?? 0, result.usage?.completion_tokens ?? 0, Date.now() - start, null);
    const content = result.choices?.[0]?.message;
    return { reachable: true, transient: false, evidence: `200 OK, response: ${JSON.stringify(content).slice(0, 100)}` };
  } catch (err: any) {
    void logProbeRequest(ctx.platform, ctx.modelId, 'error', 0, 0, Date.now() - start, err.message);
    const msg = (err.message ?? '').toLowerCase();
    const transient = /429|rate.?limit|too many requests|timeout|aborted|econnreset|etimedout|5\d\d\b/.test(msg);
    return { reachable: false, transient, evidence: `error: ${err.message}` };
  }
}

async function recordBoolean(modelDbId: number, capability: string, supported: boolean, evidence: string) {
  await run(getPool(), `
    INSERT INTO model_capabilities (model_db_id, capability, supported, source, measured_at, evidence)
    VALUES (?, ?, ?, 'measured', now(), ?)
    ON CONFLICT (model_db_id, capability, source)
    DO UPDATE SET supported = EXCLUDED.supported, measured_at = now(), evidence = EXCLUDED.evidence, suspect = false
  `, [modelDbId, capability, supported, evidence.slice(0, 500)]);
}

const CODING_NAME_PATTERN = /code|coder|codestral|devstral/i;

async function main() {
  await initDb();
  const pool = getPool();

  const keyedPlatforms = (await all<{ platform: string }>(pool, `SELECT DISTINCT platform FROM api_keys WHERE enabled = true AND status != 'invalid'`)).map((r) => r.platform);
  console.log(`Sweeping ${keyedPlatforms.length} keyed platforms: ${keyedPlatforms.join(', ')}\n`);

  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : undefined;

  const models = await all<ModelRow>(pool, `
    SELECT id, platform, model_id, display_name, speed_rank, intelligence_rank, size_label, context_window
    FROM models WHERE enabled = true AND platform = ANY(?::text[])
    ORDER BY platform, model_id
    ${limit ? 'LIMIT ' + limit : ''}
  `, [keyedPlatforms]);

  console.log(`Total models to sweep: ${models.length}\n`);

  let reachableCount = 0;
  let unreachableCount = 0;
  let skippedTransient = 0;

  for (const model of models) {
    const ctx = await contextFor(model.platform, model);
    if (!ctx) { console.log(`[${model.platform}/${model.model_id}] no provider/key, skipping entirely`); continue; }

    console.log(`\n--- ${model.platform}/${model.model_id} (${model.size_label}, intel_rank=${model.intelligence_rank}, speed_rank=${model.speed_rank}) ---`);

    // 1. Reachability — explicit, never left ambiguous per Adam's directive.
    const reach = await checkReachable(ctx);
    if (reach.transient) {
      console.log(`  reachable: SKIPPED (transient — ${reach.evidence.slice(0, 80)})`);
      skippedTransient++;
      await sleep(DELAY_MS);
      continue; // don't burn further probes on a model we couldn't even confirm is reachable right now
    }
    await recordBoolean(model.id, 'reachable', reach.reachable, reach.evidence);
    console.log(`  reachable: ${reach.reachable}`);
    reach.reachable ? reachableCount++ : unreachableCount++;
    await sleep(DELAY_MS);

    if (!reach.reachable) continue; // no point probing capabilities on a dead model

    // 2. Core capabilities.
    const toolsResult = await probeTools(ctx);
    await recordProbeResult('tools', ctx, toolsResult, false);
    console.log(`  tools: ${toolsResult.passed ? 'PASS' : toolsResult.transient ? 'SKIPPED (transient)' : 'FAIL'}`);
    await sleep(DELAY_MS);

    const jsonResult = await probeJsonMode(ctx);
    await recordProbeResult('json_mode', ctx, jsonResult, false);
    console.log(`  json_mode: ${jsonResult.passed ? 'PASS' : jsonResult.transient ? 'SKIPPED (transient)' : 'FAIL'}`);
    await sleep(DELAY_MS);

    // 3. Long-context — scaled to ~60% of the model's OWN declared window
    // (capped at 100k to bound cost for huge-window models), so this tests
    // each model meaningfully against its own claim rather than one
    // arbitrary number for every model regardless of declared size.
    let longContextResult: ProbeOutcome = { passed: false, latencyMs: 0, evidence: 'not probed (declared window too small)' };
    if (model.context_window && model.context_window >= 8000) {
      const target = Math.min(Math.floor(model.context_window * 0.6), 100000);
      longContextResult = await probeLongContext(ctx, target);
      await recordProbeResult('long_context', ctx, longContextResult, false);
      console.log(`  long_context (@~${target}tok): ${longContextResult.passed ? 'PASS' : longContextResult.transient ? 'SKIPPED (transient)' : 'FAIL'}`);
      await sleep(DELAY_MS);
    } else {
      console.log(`  long_context: skipped (declared window ${model.context_window} too small to test meaningfully)`);
    }

    // 4. Best-use taxonomy — derived from real measured signals + the
    // catalog's own pre-existing curated ranks, never a fresh judgment call.
    const latencyMs = toolsResult.latencyMs;
    const isFast = latencyMs < 3000;
    const isFrontier = model.size_label === 'Frontier';
    const isSmallOrMedium = model.size_label === 'Small' || model.size_label === 'Medium';

    await recordBoolean(model.id, 'best_use_fast_chat', isFast && isSmallOrMedium, `avg probe latency ${latencyMs}ms, size_label=${model.size_label}`);
    await recordBoolean(model.id, 'best_use_long_context', longContextResult.passed === true, `long_context probe ${longContextResult.passed ? 'passed' : 'did not pass'}`);
    await recordBoolean(model.id, 'best_use_heavy_reasoning', isFrontier, `catalog size_label=${model.size_label} (curated tier, not a fresh probe)`);
    await recordBoolean(model.id, 'best_use_tool_use', toolsResult.passed, `tools probe ${toolsResult.passed ? 'passed' : 'did not pass'}`);
    const codingMatch = CODING_NAME_PATTERN.test(model.model_id) || CODING_NAME_PATTERN.test(model.display_name);
    await recordBoolean(model.id, 'best_use_coding', codingMatch, `HEURISTIC (catalog-name pattern match, not a measured probe): model_id/display_name ${codingMatch ? 'matches' : 'does not match'} coding-related naming`);

    let latencyTier = 'slow';
    if (latencyMs < 2000) latencyTier = 'fast';
    else if (latencyMs < 8000) latencyTier = 'medium';
    await recordBoolean(model.id, `best_use_latency_${latencyTier}`, true, `measured probe latency ${latencyMs}ms`);

    console.log(`  best_use: fast_chat=${isFast && isSmallOrMedium} long_context=${longContextResult.passed} heavy_reasoning=${isFrontier} tool_use=${toolsResult.passed} coding(heuristic)=${codingMatch} latency_tier=${latencyTier}`);

    await sleep(DELAY_MS);
  }

  console.log(`\n=== SWEEP COMPLETE: ${models.length} models, ${reachableCount} reachable, ${unreachableCount} unreachable, ${skippedTransient} skipped (transient) ===`);

  await closeDb();
}

main().catch((err) => {
  console.error('Full catalog sweep failed:', err);
  process.exit(1);
});
