// One-shot manual probe runner — populates REAL measured capability data
// against the currently-configured real keys. Usage: npx tsx src/scripts/run-probes.ts
import '../env.js';
import { initDb, closeDb } from '../db/index.js';
import { all, get } from '../db/pgCompat.js';
import { getPool } from '../db/index.js';
import { getProbeContext, recordProbeResult } from '../services/probes/runner.js';
import { probeTools, probeJsonMode } from '../services/probes/methods.js';

async function main() {
  await initDb();
  const pool = getPool();

  const platforms = await all<{ platform: string }>(pool, `
    SELECT DISTINCT platform FROM api_keys WHERE enabled = true AND status != 'invalid'
  `);

  console.log(`Probing ${platforms.length} platforms with configured keys: ${platforms.map(p => p.platform).join(', ')}\n`);

  for (const { platform } of platforms) {
    const ctx = await getProbeContext(platform);
    if (!ctx) {
      console.log(`[${platform}] no eligible model+key context, skipping`);
      continue;
    }

    console.log(`[${platform}/${ctx.modelId}] probing tools...`);
    const toolsResult = await probeTools(ctx);
    await recordProbeResult('tools', ctx, toolsResult, false);
    console.log(`  -> ${toolsResult.passed ? 'PASS' : 'FAIL'} (${toolsResult.latencyMs}ms) ${toolsResult.evidence.slice(0, 120)}`);

    console.log(`[${platform}/${ctx.modelId}] probing json_mode...`);
    const jsonResult = await probeJsonMode(ctx);
    await recordProbeResult('json_mode', ctx, jsonResult, false);
    console.log(`  -> ${jsonResult.passed ? 'PASS' : 'FAIL'} (${jsonResult.latencyMs}ms) ${jsonResult.evidence.slice(0, 120)}`);
    console.log('');
  }

  const summary = await all(pool, `
    SELECT m.platform, m.model_id, mc.capability, mc.supported, mc.measured_at
    FROM model_capabilities mc JOIN models m ON m.id = mc.model_db_id
    WHERE mc.source = 'measured'
    ORDER BY m.platform, mc.capability
  `);
  console.log('=== model_capabilities (measured) ===');
  console.table(summary);

  await closeDb();
}

main().catch((err) => {
  console.error('Probe run failed:', err);
  process.exit(1);
});
