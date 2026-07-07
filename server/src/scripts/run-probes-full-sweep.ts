// Full sweep: probe tools + json_mode against EVERY enabled model on every
// platform feeder currently holds a live key for — not just the single
// highest-intelligence-rank model per platform (that's what run-probes.ts
// does). Adam/wsl flagged the "only 2 tools-capable models" pool as
// implausibly thin; wsl's own spot-check (8/8 hit rate via Hermes's broader
// key set) suggests the real number is a probing-coverage gap, not a true
// capability gap. This sweep tests that hypothesis against feeder's OWN key
// store (4 platforms today: nvidia, cerebras, groq, google — 26 enabled
// models total; feeder cannot probe platforms it holds no key for, unlike
// Hermes which has broader provider access).
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, get } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { recordProbeResult, type ProbeContext } from '../services/probes/runner.js';
import { probeTools, probeJsonMode } from '../services/probes/methods.js';

const DELAY_MS = 1500; // courtesy delay between calls — avoid tripping free-tier RPM ceilings mid-sweep
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await initDb();
  const pool = getPool();

  const keyedPlatforms = await all<{ platform: string }>(pool,
    `SELECT DISTINCT platform FROM api_keys WHERE enabled = true AND status != 'invalid'`
  );

  const results: Array<{ platform: string; modelId: string; tools?: boolean; jsonMode?: boolean; error?: string }> = [];

  for (const { platform } of keyedPlatforms) {
    const keyRow = await get<{ id: number; encrypted_key: string; iv: string; auth_tag: string }>(pool,
      `SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = true AND status != 'invalid' LIMIT 1`,
      [platform]
    );
    if (!keyRow) continue;
    const provider = getProvider(platform as any);
    if (!provider) continue;
    const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);

    const models = await all<{ id: number; model_id: string }>(pool,
      `SELECT id, model_id FROM models WHERE platform = ? AND enabled = true ORDER BY intelligence_rank ASC`,
      [platform]
    );

    console.log(`\n=== ${platform}: ${models.length} enabled models ===`);

    for (const m of models) {
      const ctx: ProbeContext = { provider, apiKey, modelId: m.model_id, modelDbId: m.id, platform };
      const row: { platform: string; modelId: string; tools?: boolean; jsonMode?: boolean; error?: string } = {
        platform, modelId: m.model_id,
      };
      try {
        const toolsResult = await probeTools(ctx);
        await recordProbeResult('tools', ctx, toolsResult, false);
        row.tools = toolsResult.passed;
        console.log(`  [${m.model_id}] tools: ${toolsResult.passed ? 'PASS' : 'FAIL'} — ${toolsResult.evidence.slice(0, 100)}`);
      } catch (err: any) {
        row.error = `tools probe threw: ${err.message}`;
        console.log(`  [${m.model_id}] tools: ERROR — ${err.message}`);
      }
      await sleep(DELAY_MS);

      try {
        const jsonResult = await probeJsonMode(ctx);
        await recordProbeResult('json_mode', ctx, jsonResult, false);
        row.jsonMode = jsonResult.passed;
        console.log(`  [${m.model_id}] json_mode: ${jsonResult.passed ? 'PASS' : 'FAIL'} — ${jsonResult.evidence.slice(0, 100)}`);
      } catch (err: any) {
        row.error = (row.error ? row.error + '; ' : '') + `json_mode probe threw: ${err.message}`;
        console.log(`  [${m.model_id}] json_mode: ERROR — ${err.message}`);
      }
      await sleep(DELAY_MS);

      results.push(row);
    }
  }

  const toolsPassed = results.filter((r) => r.tools).length;
  const jsonPassed = results.filter((r) => r.jsonMode).length;
  console.log(`\n=== SWEEP SUMMARY: ${results.length} models probed, ${toolsPassed} tools=true, ${jsonPassed} json_mode=true ===`);

  const summary = await all(pool, `
    SELECT m.platform, m.model_id, mc.capability, mc.supported
    FROM model_capabilities mc JOIN models m ON m.id = mc.model_db_id
    WHERE mc.source = 'measured' AND mc.capability IN ('tools', 'json_mode')
    ORDER BY m.platform, m.model_id, mc.capability
  `);
  console.table(summary);

  await closeDb();
}

main().catch((err) => {
  console.error('Full sweep failed:', err);
  process.exit(1);
});
