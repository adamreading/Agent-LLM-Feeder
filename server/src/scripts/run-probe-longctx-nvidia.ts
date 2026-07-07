// Re-test nvidia/mistral-large-3 long-context probe with a realistic timeout.
// The first run (run-probe-longctx.ts) aborted at exactly 15000ms — that's
// OpenAICompatProvider's default HTTP timeout firing on a large-prompt
// request, not evidence the model mishandles its declared context. This
// isolates that variable with a longer timeout, matching openai-compat.ts's
// own comment that cloud APIs can legitimately need more than 15s for large
// prompts.
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { get } from '../db/pgCompat.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { decrypt } from '../lib/crypto.js';
import { recordProbeResult, type ProbeContext } from '../services/probes/runner.js';
import { probeLongContext } from '../services/probes/methods.js';

async function main() {
  await initDb();
  const pool = getPool();

  const platform = 'nvidia';
  const modelId = 'mistralai/mistral-large-3-675b-instruct-2512';

  const keyRow = await get<{ id: number; encrypted_key: string; iv: string; auth_tag: string }>(pool,
    `SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = true AND status != 'invalid' LIMIT 1`,
    [platform]
  );
  const modelRow = await get<{ id: number }>(pool, `SELECT id FROM models WHERE platform = ? AND model_id = ?`, [platform, modelId]);
  if (!keyRow || !modelRow) {
    console.log('no key/model context, aborting');
    await closeDb();
    return;
  }

  // Long-timeout provider instance for this probe only — production nvidia
  // registration keeps its 15s default, this is a diagnostic-only override.
  const longTimeoutProvider = new OpenAICompatProvider({
    platform: 'nvidia',
    name: 'NVIDIA NIM (long-timeout probe)',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    dialect: { jsonMode: true },
    timeoutMs: 90000,
  });

  const ctx: ProbeContext = {
    provider: longTimeoutProvider,
    apiKey: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag),
    modelId,
    modelDbId: modelRow.id,
    platform,
  };

  console.log(`[${platform}/${modelId}] probing long_context @ ~100000 tokens with 90s timeout...`);
  const result = await probeLongContext(ctx, 100000);
  await recordProbeResult('long_context', ctx, result, false);
  console.log(`  -> ${result.passed ? 'PASS' : 'FAIL'} (${result.latencyMs}ms) ${result.evidence.slice(0, 300)}`);

  await closeDb();
}

main().catch((err) => {
  console.error('Long-context nvidia re-probe failed:', err);
  process.exit(1);
});
