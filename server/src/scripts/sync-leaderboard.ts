// Import external quality priors now: `npm run leaderboard` (run from server/).
//
// Hits the RUNNING server's POST /api/catalog/leaderboard?wait=1 (localhost-only)
// so it shares the in-process guard with the weekly scheduler. ZERO model tokens:
// 8 GETs of arena.ai leaderboard pages + 1 GET of the Artificial Analysis API
// (only if ARTIFICIAL_ANALYSIS_API_KEY is set). See services/leaderboardSync.ts.
import '../env.js';

const PORT = process.env.PORT ?? 3001;
const url = `http://localhost:${PORT}/api/catalog/leaderboard?wait=1`;

async function main() {
  console.log(`Importing leaderboard priors via ${url} (8 arena pages + AA if keyed; ~1 min)…\n`);
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST' });
  } catch (e: any) {
    if (e?.cause?.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(e?.message ?? '')) {
      console.error(`Could not reach feeder on :${PORT} — is the server running? Start it with \`npm start\`, then retry.`);
    } else console.error(`Request failed: ${e?.message ?? e}`);
    process.exit(1);
  }
  const s: any = await res.json().catch(() => null);
  if (!res.ok) { console.error(`HTTP ${res.status}: ${JSON.stringify(s)}`); process.exit(1); }
  if (s?.note) console.log(`note: ${s.note}\n`);
  console.log(`LMArena (arena.ai):        ${s.arena.pages}/8 pages, ${s.arena.ratings} ratings → ${s.arena.written} scores over ${s.arena.matchedCanonicals} models${s.arena.err ? '  ERR: ' + s.arena.err : ''}`);
  console.log(`Artificial Analysis:       ${s.aa.skipped ? 'skipped — ' + s.aa.skipped : `${s.aa.models} models → ${s.aa.written} scores over ${s.aa.matchedCanonicals} models`}${s.aa.err ? '  ERR: ' + s.aa.err : ''}`);
  if (s.params) console.log(`Params backfill:           +${s.params.fromName} from name, +${s.params.fromHf} from HF (${s.params.hfTried} looked up), ${s.params.stillMissing} still missing${s.params.err ? '  ERR: ' + s.params.err : ''}`);
  if (s.unmatchedSample?.length) console.log(`Unmatched board names (sample): ${s.unmatchedSample.join(', ')}`);
  console.log(`\nDone (${s.startedAt} → ${s.finishedAt}). Routing uses these as the quality prior; research-estimate scores now count at reduced confidence.`);
}

main();
