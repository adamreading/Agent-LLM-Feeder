// P3 research cron entry point — weekly cadence (Adam's steer, 2026-07-07:
// model-landscape discovery moves weekly, distinct from realtime quota
// harvest and on-change probe re-verification). Populates 'declared'
// model_capabilities rows via web search, never touching 'measured' data.
//
// Usage: npx tsx src/scripts/run-research-cron.ts [--limit N]
// Defaults to researching every enabled catalog model; --limit caps it for
// a bounded demonstration/test run without burning search+extraction calls
// against all 89 models.
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all } from '../db/pgCompat.js';
import { researchModel, recordDeclaredFacts } from '../services/research.js';

const DELAY_MS = 2000; // courtesy delay between models — 2 real API calls (search + extraction) per model
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await initDb();
  const pool = getPool();

  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : undefined;

  const models = await all<{ id: number; platform: string; model_id: string }>(pool, `
    SELECT id, platform, model_id FROM models WHERE enabled = true ORDER BY platform, model_id
    ${limit ? 'LIMIT ' + limit : ''}
  `);

  console.log(`Researching ${models.length} models via Ollama web search...\n`);

  let researched = 0;
  let factsWritten = 0;

  for (const m of models) {
    try {
      const outcome = await researchModel(m.platform, m.model_id);
      await recordDeclaredFacts(m.id, outcome);
      researched++;
      factsWritten += outcome.facts.length;
      console.log(`[${m.platform}/${m.model_id}] ${outcome.facts.length} facts from ${outcome.sourcesUsed.length} sources: ${JSON.stringify(outcome.facts)}`);
    } catch (err: any) {
      console.log(`[${m.platform}/${m.model_id}] ERROR: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`\n=== RESEARCH CRON SUMMARY: ${researched}/${models.length} models researched, ${factsWritten} declared facts written ===`);

  const summary = await all(pool, `
    SELECT m.platform, m.model_id, mc.capability, mc.supported, mc.evidence
    FROM model_capabilities mc JOIN models m ON m.id = mc.model_db_id
    WHERE mc.source = 'declared'
    ORDER BY m.platform, m.model_id, mc.capability
  `);
  console.log('\n=== all declared facts in DB ===');
  console.table(summary);

  await closeDb();
}

main().catch((err) => {
  console.error('Research cron run failed:', err);
  process.exit(1);
});
