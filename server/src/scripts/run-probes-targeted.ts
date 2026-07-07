import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, get } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { recordProbeResult, type ProbeContext } from '../services/probes/runner.js';
import { probeTools, probeJsonMode } from '../services/probes/methods.js';

const TARGETS: Array<{ platform: string; modelId: string }> = [
  { platform: 'nvidia', modelId: 'mistralai/mistral-large-3-675b-instruct-2512' },
  { platform: 'nvidia', modelId: 'meta/llama-3.3-70b-instruct' },
  { platform: 'cerebras', modelId: 'gpt-oss-120b' },
];

async function contextFor(platform: string, modelId: string): Promise<ProbeContext | null> {
  const pool = getPool();
  const keyRow = await get<{ id: number; encrypted_key: string; iv: string; auth_tag: string }>(pool,
    `SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = true AND status != 'invalid' LIMIT 1`,
    [platform]
  );
  if (!keyRow) return null;
  const modelRow = await get<{ id: number }>(pool, `SELECT id FROM models WHERE platform = ? AND model_id = ?`, [platform, modelId]);
  if (!modelRow) return null;
  const provider = getProvider(platform as any);
  if (!provider) return null;
  return {
    provider,
    apiKey: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag),
    modelId,
    modelDbId: modelRow.id,
    platform,
  };
}

async function main() {
  await initDb();
  const pool = getPool();

  for (const target of TARGETS) {
    const ctx = await contextFor(target.platform, target.modelId);
    if (!ctx) {
      console.log(`[${target.platform}/${target.modelId}] no key/model context, skipping`);
      continue;
    }
    console.log(`[${target.platform}/${target.modelId}] probing tools...`);
    const toolsResult = await probeTools(ctx);
    await recordProbeResult('tools', ctx, toolsResult, false);
    console.log(`  -> ${toolsResult.passed ? 'PASS' : 'FAIL'} (${toolsResult.latencyMs}ms) ${toolsResult.evidence.slice(0, 150)}`);

    console.log(`[${target.platform}/${target.modelId}] probing json_mode...`);
    const jsonResult = await probeJsonMode(ctx);
    await recordProbeResult('json_mode', ctx, jsonResult, false);
    console.log(`  -> ${jsonResult.passed ? 'PASS' : 'FAIL'} (${jsonResult.latencyMs}ms) ${jsonResult.evidence.slice(0, 150)}`);
    console.log('');
  }

  const summary = await all(pool, `
    SELECT m.platform, m.model_id, mc.capability, mc.supported, mc.measured_at
    FROM model_capabilities mc JOIN models m ON m.id = mc.model_db_id
    WHERE mc.source = 'measured'
    ORDER BY m.platform, m.model_id, mc.capability
  `);
  console.log('=== model_capabilities (measured), all runs ===');
  console.table(summary);

  await closeDb();
}

main().catch((err) => {
  console.error('Targeted probe run failed:', err);
  process.exit(1);
});
