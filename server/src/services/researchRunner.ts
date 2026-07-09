import type pg from 'pg';
import { all } from '../db/pgCompat.js';
import { getWriterModel, researchCanonicalModel, recordResearch } from './modelResearch.js';
import { searchConfigured } from './webSearch.js';

// Background "research everything without a summary" runner, shared by the
// wiki page's "RESEARCH MISSING" button (routes/canon.ts) and the on-demand
// CLI script. A single module-level runner guards against two passes racing
// each other into the web-search backend's hourly quota — there is exactly
// ONE research pass in flight at a time, whoever triggers it.
//
// A search rate-limit (Ollama's free hourly cap) stops the pass cleanly and
// records `rateLimited` so the caller can resume later — recordResearch is
// idempotent (never overwrites a good summary with null), so a re-run just
// fills the remaining gaps.

export interface ResearchStatus {
  running: boolean;
  total: number;        // models targeted when the current/last run started
  done: number;         // summaries successfully written this run
  empty: number;        // researched but no usable data found
  failed: number;       // errored (non-rate-limit)
  remaining: number;    // canonical models still lacking a summary right now
  rateLimited: boolean; // last run stopped on the search backend's rate limit
  lastError: string | null;
  current: string | null; // model currently being researched
  startedAt: string | null;
  finishedAt: string | null;
}

let status: ResearchStatus = {
  running: false, total: 0, done: 0, empty: 0, failed: 0, remaining: 0,
  rateLimited: false, lastError: null, current: null, startedAt: null, finishedAt: null,
};

const DELAY_MS = Number(process.env.RESEARCH_DELAY_MS) || 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function countMissing(pool: pg.Pool): Promise<number> {
  const rows = await all<{ n: number }>(pool, `SELECT count(*)::int n FROM canonical_models WHERE summary IS NULL OR summary = ''`);
  return rows[0]?.n ?? 0;
}

export async function getResearchStatus(pool: pg.Pool): Promise<ResearchStatus> {
  // Report live remaining even between runs so the button label stays honest.
  return { ...status, remaining: await countMissing(pool) };
}

// Kick off a pass over every summary-less canonical model. Returns immediately
// with the starting status; the pass runs in the background (fire-and-forget,
// like logRequest) so an HTTP caller isn't held open for the whole catalog.
export async function startMissingResearch(pool: pg.Pool): Promise<ResearchStatus & { started: boolean; reason?: string }> {
  if (status.running) return { ...status, started: false, reason: 'A research pass is already running.' };
  if (!searchConfigured()) return { ...status, started: false, reason: 'No web-search backend configured (set WEB_SEARCH_BACKEND + its API key).' };
  const writer = await getWriterModel(pool);
  if (!writer) return { ...status, started: false, reason: 'No writer model available (set RESEARCH_MODEL or add a json_mode-capable key).' };

  const targets = await all<{ id: number; name: string }>(pool, `
    SELECT id, name FROM canonical_models WHERE summary IS NULL OR summary = '' ORDER BY name ASC
  `);
  status = {
    running: true, total: targets.length, done: 0, empty: 0, failed: 0, remaining: targets.length,
    rateLimited: false, lastError: null, current: null, startedAt: new Date().toISOString(), finishedAt: null,
  };

  // Detached async loop — deliberately not awaited by the caller.
  void (async () => {
    for (const t of targets) {
      status.current = t.name;
      try {
        const res = await researchCanonicalModel(pool, t.id, writer);
        if (res.summary || Object.keys(res.tasks).length) {
          await recordResearch(pool, t.id, res);
          status.done++;
        } else {
          status.empty++;
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        // Only a SEARCH-backend rate-limit (tagged) stops the pass; a writer
        // 429 is retried internally then skips just that model.
        if (err?.isSearchError && /429|rate.?limit|hourly|anomaly|session usage|limit/i.test(msg)) {
          status.rateLimited = true;
          status.lastError = 'Web-search rate limit reached — stopped; re-run later to continue.';
          break;
        }
        status.failed++;
        status.lastError = msg;
      }
      await sleep(DELAY_MS);
    }
    status.running = false;
    status.current = null;
    status.finishedAt = new Date().toISOString();
  })();

  return { ...status, started: true };
}
