// Fill context_window for enabled instances that have none (their provider's
// /models API doesn't expose it) using DECLARED research: Tavily-search the
// model's documented native context window, extract the number via the JSON
// router, and write it. Marked declared (native) — a specific provider may
// serve less; that's a separate measured concern. Adam's call (2026-07-13).
// Dedups by canonical to minimise search/extractor calls. Usage:
//   npx tsx src/scripts/declared-context.ts
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, run } from '../db/pgCompat.js';
import { loadSearchConfigIntoEnv } from '../services/searchConfig.js';
import { searchConfigured } from '../services/webSearch.js';
import { poolSearch } from '../services/searchPool.js';
import { routedChat } from '../services/routedCompletion.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await initDb();
  await loadSearchConfigIntoEnv(getPool());
  if (!searchConfigured()) { console.error('no search backend'); process.exit(1); }

  // distinct canonicals with a null-context enabled instance + a representative model_id/name
  const groups = await all<{ canonical_id: number; name: string; sample_model: string }>(getPool(), `
    SELECT c.id AS canonical_id, c.name,
           (array_agg(m.model_id ORDER BY length(m.model_id)))[1] AS sample_model
    FROM canonical_models c
    JOIN models m ON m.canonical_model_id = c.id
    WHERE m.enabled = true AND m.context_window IS NULL
    GROUP BY c.id, c.name ORDER BY c.name`);
  console.log(`${groups.length} canonicals need a declared context window.\n`);

  let filled = 0, notfound = 0;
  for (const g of groups) {
    const leaf = (g.sample_model.split('/').pop() ?? g.sample_model).replace(/:free$/, '');
    const res = await poolSearch(`${leaf} model maximum context window length tokens`, 5);
    if (!res.results.length && res.reason === 'throttled') { console.log('search pool throttled — stopping; re-run later.'); break; }
    const snippets = res.results.map((r) => `# ${r.title}\n${r.content}`).join('\n\n').slice(0, 6000);
    if (!snippets) { notfound++; console.log(`[no-snippets] ${g.name}`); continue; }

    const prompt = `From the sources below, what is the MAXIMUM context window (in tokens) of the LLM "${leaf}"? Only use an EXPLICITLY stated number for THIS model. Convert "128k"->131072, "1M"->1048576, "200k"->200000 style values to exact token counts. If not explicitly stated for this model, return null.\n\nReturn ONLY: {"context_tokens": <integer or null>}\n\nSOURCES:\n${snippets}`;
    const routed = await routedChat([{ role: 'user', content: prompt }], { needs: ['json_mode'], responseFormat: { type: 'json_object' }, taskClass: 'research', maxTokens: 80, excludeReasoning: true });
    let ctx: number | null = null;
    if (routed?.content) {
      try {
        const m = routed.content.match(/\{[\s\S]*\}/);
        if (m) { const v = JSON.parse(m[0])?.context_tokens; if (typeof v === 'number' && v >= 1024 && v <= 20_000_000) ctx = Math.round(v); }
      } catch { /* ignore */ }
    }
    if (ctx) {
      const res = await run(getPool(), `UPDATE models SET context_window = ? WHERE canonical_model_id = ? AND enabled = true AND context_window IS NULL`, [ctx, g.canonical_id]);
      filled++; console.log(`[ok] ${g.name.padEnd(34)} -> ${ctx}`);
    } else { notfound++; console.log(`[none] ${g.name}`); }
    await sleep(400);
  }
  console.log(`\nFilled ${filled}, no-number ${notfound}.`);
  const summary = await all<{ n: string }>(getPool(), `SELECT count(*) n FROM models WHERE enabled AND context_window IS NULL`);
  console.log(`enabled instances still missing context: ${summary[0].n}`);
  await closeDb();
}
main().catch(e => { console.error(e); process.exit(1); });
