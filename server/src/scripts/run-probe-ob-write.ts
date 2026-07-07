// ob_write half of Adam's main-brain minimum bar (ob_readwrite = tools AND
// ctx-floor AND ob_readwrite). Runs against the 16 models already confirmed
// tools=true — a model that can't function-call at all has no chance of
// driving ajo_capture_pending correctly either, so there's no point probing
// the full catalog for this. Records 'ob_write' as its own capability; once
// the read-half (ob_read) is unblocked (windows-claude to hand over a
// stable existing-thought anchor, per wsl's zero-write proposal), a
// follow-up run computes the combined 'ob_readwrite' = ob_write AND ob_read.
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, get } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { recordProbeResult, type ProbeContext } from '../services/probes/runner.js';
import { probeObWrite, type ObConfig } from '../services/probes/methods.js';

const DELAY_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await initDb();
  const pool = getPool();

  const supabaseUrl = process.env.SUPABASE_URL;
  const mcpKey = process.env.MCP_ACCESS_KEY;
  if (!supabaseUrl || !mcpKey) {
    console.error('SUPABASE_URL / MCP_ACCESS_KEY not set — aborting');
    process.exit(1);
  }

  const ob: ObConfig = {
    baseUrl: `${supabaseUrl}/functions/v1/rest-api`,
    authHeader: { 'x-brain-key': mcpKey },
    searchPath: '/search', // unused by the write probe
    readFixtureMarker: '', // unused by the write probe
  };

  const targets = await all<{ platform: string; model_id: string; model_db_id: number }>(pool, `
    SELECT m.platform, m.model_id, m.id AS model_db_id
    FROM model_capabilities mc JOIN models m ON m.id = mc.model_db_id
    WHERE mc.capability = 'tools' AND mc.supported = true AND mc.source = 'measured'
    ORDER BY m.platform, m.model_id
  `);

  console.log(`Probing ob_write against ${targets.length} tools-confirmed models\n`);

  for (const t of targets) {
    const keyRow = await get<{ encrypted_key: string; iv: string; auth_tag: string }>(pool,
      `SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = true AND status != 'invalid' LIMIT 1`,
      [t.platform]
    );
    const provider = getProvider(t.platform as any);
    if (!keyRow || !provider) {
      console.log(`[${t.platform}/${t.model_id}] no key/provider, skipping`);
      continue;
    }
    const ctx: ProbeContext = {
      provider,
      apiKey: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag),
      modelId: t.model_id,
      modelDbId: t.model_db_id,
      platform: t.platform,
    };
    const runId = `${t.platform}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await probeObWrite(ctx, ob, runId);
    await recordProbeResult('ob_write', ctx, result, false);
    console.log(`[${t.platform}/${t.model_id}] ob_write: ${result.passed ? 'PASS' : result.transient ? 'SKIPPED (transient)' : 'FAIL'} — ${result.evidence.slice(0, 150)}`);
    await sleep(DELAY_MS);
  }

  const summary = await all(pool, `
    SELECT m.platform, m.model_id, mc.supported, mc.measured_at
    FROM model_capabilities mc JOIN models m ON m.id = mc.model_db_id
    WHERE mc.capability = 'ob_write' AND mc.source = 'measured'
    ORDER BY m.platform, m.model_id
  `);
  console.log('\n=== ob_write results ===');
  console.table(summary);

  await closeDb();
}

main().catch((err) => {
  console.error('ob_write probe run failed:', err);
  process.exit(1);
});
