// On-demand model-research run: for every canonical model, do web research
// (arena.ai/leaderboard + general search via the configured web-search
// backend) and have the fleet's own writer model synthesize a summary +
// per-task scores, written back to canonical_models.summary + task_scores.
//
// Runnable on demand:  npx tsx src/scripts/run-model-research.ts [--limit N]
// NOT wired to a persistent timer — a standing autonomous job that spends
// provider quota on a schedule is a separate authorization question (same
// class as the probe scheduler); the mechanism is built and safe to run when
// asked. Config: WEB_SEARCH_BACKEND (+ its API key, e.g. OLLAMA_API_KEY) and
// optionally RESEARCH_MODEL — see .env.example.
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all } from '../db/pgCompat.js';
import { getWriterModel, researchCanonicalModel, recordResearch } from '../services/modelResearch.js';
import { searchConfigured } from '../services/webSearch.js';
import { loadSearchConfigIntoEnv } from '../services/searchConfig.js';

// Inter-model delay — raise it for a low-rpm writer (e.g. RESEARCH_DELAY_MS=
// 30000 for a 2-rpm free tier) so the writer model isn't rate-limited.
const DELAY_MS = Number(process.env.RESEARCH_DELAY_MS) || 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await initDb();
  const pool = getPool();
  // Pick up the UI-managed backend + key (e.g. Tavily) the same as the server.
  await loadSearchConfigIntoEnv(pool);

  if (!searchConfigured()) {
    console.error('No web-search backend configured. Set WEB_SEARCH_BACKEND (default "ollama") and its API key (e.g. OLLAMA_API_KEY) in .env.');
    process.exit(1);
  }
  const writer = await getWriterModel(pool);
  if (!writer) {
    console.error('No writer model available. Set RESEARCH_MODEL=platform/model_id in .env, or add a key for a json_mode-capable model.');
    process.exit(1);
  }
  console.log(`Writer model: ${writer.platform}/${writer.modelId}`);

  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : undefined;
  // By default only fill the GAPS — models that still have no summary — so a
  // re-run after a rate-limit stop doesn't spend quota re-researching the ones
  // already written. Pass --all to force a full refresh of every model.
  const all_ = process.argv.includes('--all');
  const where = all_ ? '' : `WHERE summary IS NULL OR summary = ''`;

  const canonicals = await all<{ id: number; name: string }>(pool, `
    SELECT id, name FROM canonical_models ${where} ORDER BY name ASC ${limit ? 'LIMIT ' + limit : ''}
  `);
  console.log(`Researching ${canonicals.length} canonical models${all_ ? '' : ' (missing summaries only)'}…\n`);

  let ok = 0, empty = 0, failed = 0;
  for (const c of canonicals) {
    try {
      const res = await researchCanonicalModel(pool, c.id, writer);
      if (res.summary || Object.keys(res.tasks).length) {
        await recordResearch(pool, c.id, res);
        ok++;
        console.log(`  ✓ ${c.name} — summary:${res.summary ? 'yes' : 'no'} tasks:${Object.keys(res.tasks).length}`);
      } else {
        empty++;
        console.log(`  · ${c.name} — no usable data found`);
      }
    } catch (err: any) {
      failed++;
      console.log(`  ✗ ${c.name} — ${err.message}`);
      // The web-search backend's rate limit (e.g. Ollama's hourly cap) stops
      // the run cleanly — re-run later to fill the rest; already-written
      // summaries persist (recordResearch never overwrites with null).
      if (/429|rate.?limit|hourly|search .*limit/i.test(err.message ?? '')) {
        console.log('\n⚠ Web-search rate limit reached — stopping. Re-run later to continue; done models are saved.');
        break;
      }
    }
    await sleep(DELAY_MS);
  }

  console.log(`\n=== RESEARCH COMPLETE: ${ok} written, ${empty} empty, ${failed} failed ===`);
  await closeDb();
}

main().catch((err) => { console.error('Model research failed:', err); process.exit(1); });
