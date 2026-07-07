// One-shot: verify declared long-context windows are honest (needle-recall),
// not just a spec-sheet number the serving stack silently truncates against.
// Targets the two models currently confirmed tools=true — this is exactly
// the pool auto/agentic_chat+tools can land on today, so it's the pool that
// actually matters for wsl's 100k+-token main-brain-turn concern.
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, get } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { recordProbeResult, type ProbeContext } from '../services/probes/runner.js';
import { probeLongContext } from '../services/probes/methods.js';

const TARGETS: Array<{ platform: string; modelId: string; targetTokens: number }> = [
  { platform: 'nvidia', modelId: 'mistralai/mistral-large-3-675b-instruct-2512', targetTokens: 100000 },
  { platform: 'groq', modelId: 'openai/gpt-oss-120b', targetTokens: 100000 },
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
    console.log(`[${target.platform}/${target.modelId}] probing long_context @ ~${target.targetTokens} tokens...`);
    const result = await probeLongContext(ctx, target.targetTokens);
    await recordProbeResult('long_context', ctx, result, false);
    console.log(`  -> ${result.passed ? 'PASS' : 'FAIL'} (${result.latencyMs}ms) ${result.evidence.slice(0, 200)}`);
    console.log('');
  }

  const summary = await all(pool, `
    SELECT m.platform, m.model_id, mc.capability, mc.supported, mc.measured_at
    FROM model_capabilities mc JOIN models m ON m.id = mc.model_db_id
    WHERE mc.capability = 'long_context'
    ORDER BY m.platform
  `);
  console.log('=== model_capabilities (long_context, measured) ===');
  console.table(summary);

  await closeDb();
}

main().catch((err) => {
  console.error('Long-context probe run failed:', err);
  process.exit(1);
});
