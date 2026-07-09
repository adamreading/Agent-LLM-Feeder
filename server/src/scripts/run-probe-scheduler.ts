// P3 probe-bank scheduling — the third of Adam's three cadences: not realtime
// (quota harvest) and not weekly (research), but EVENT-DRIVEN on model/
// capability change. Two triggers, both discovered by polling since there's no
// push signal: suspect=true rows (production-proven regressions from the L9
// feedback loop) and never-probed keyed models (new arrivals / sweep gaps).
//
// The logic lives in services/probes/scheduler.ts and is shared with the
// auto-onboard-on-arrival path (services/autoOnboard.ts) so a model added via
// the UI gets probed automatically, and this script re-runs the same on demand:
//   npx tsx src/scripts/run-probe-scheduler.ts
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { reprobeSuspects, probeNeverProbed } from '../services/probes/scheduler.js';

async function main() {
  await initDb();
  const pool = getPool();

  console.log('=== Priority 1: suspect-flagged capabilities (production-proven regressions) ===');
  const n1 = await reprobeSuspects(pool, (m) => console.log(m));
  if (n1 === 0) console.log('(none)');

  console.log('\n=== Priority 2: never-probed models (have a key, zero measured tools/json_mode) ===');
  const n2 = await probeNeverProbed(pool, (m) => console.log(m));
  if (n2 === 0) console.log('(none)');

  await closeDb();
}

main().catch((err) => {
  console.error('Probe scheduler run failed:', err);
  process.exit(1);
});
