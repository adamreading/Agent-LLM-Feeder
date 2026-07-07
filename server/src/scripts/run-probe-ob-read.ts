// ob_read half of Adam's main-brain minimum bar. Zero-write per wsl's
// proposal: anchored on an EXISTING stable Open Brain thought (id=201, the
// system's own "always get Adam's approval before committing changes"
// governance note — windows-claude verified live it's the sole match for
// this search string) instead of seeding new fixture data. No production
// write, no Adam-gate needed for this half (unlike ob_write, which is
// paused pending Adam's direct authorization — see run-probe-ob-write.ts).
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, get } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { recordProbeResult, type ProbeContext } from '../services/probes/runner.js';
import { probeObRead, type ObConfig } from '../services/probes/methods.js';

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
    searchPath: '/search',
    readFixtureMarker: 'Always Present Proposed Changes for Review Before Committing',
  };

  const targets = await all<{ platform: string; model_id: string; model_db_id: number }>(pool, `
    SELECT m.platform, m.model_id, m.id AS model_db_id
    FROM model_capabilities mc JOIN models m ON m.id = mc.model_db_id
    WHERE mc.capability = 'tools' AND mc.supported = true AND mc.source = 'measured'
    ORDER BY m.platform, m.model_id
  `);

  console.log(`Probing ob_read against ${targets.length} tools-confirmed models\n`);

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
    const result = await probeObRead(ctx, ob);
    await recordProbeResult('ob_read', ctx, result, false);
    console.log(`[${t.platform}/${t.model_id}] ob_read: ${result.passed ? 'PASS' : result.transient ? 'SKIPPED (transient)' : 'FAIL'} — ${result.evidence.slice(0, 150)}`);
    await sleep(DELAY_MS);
  }

  const summary = await all(pool, `
    SELECT m.platform, m.model_id, mc.supported, mc.measured_at
    FROM model_capabilities mc JOIN models m ON m.id = mc.model_db_id
    WHERE mc.capability = 'ob_read' AND mc.source = 'measured'
    ORDER BY m.platform, m.model_id
  `);
  console.log('\n=== ob_read results ===');
  console.table(summary);

  await closeDb();
}

main().catch((err) => {
  console.error('ob_read probe run failed:', err);
  process.exit(1);
});
