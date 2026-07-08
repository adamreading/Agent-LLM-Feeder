import { search as ddgSearch, SafeSearchType } from 'duck-duck-scrape';
import type { SearchResult } from './webSearch.js';

// DuckDuckGo search via the maintained `duck-duck-scrape` lib (handles DDG's
// vqd token + result endpoint + parsing internally — wsl-claude's Hermes copy
// uses the Python `ddgs` equivalent). We map its result shape to feeder's
// {title,url,content}.
//
// IMPORTANT operational note (2026-07-08): DDG hard-blocks scraper traffic by
// IP reputation ("anomaly" 202). It tolerates RARE/fallback use (as in Hermes)
// but throttles sustained PRIMARY use — and a datacenter/WSL egress can be
// blocked outright regardless of cadence. So this backend adds a polite delay,
// exponential backoff on anomaly/ratelimit, and a short result cache to be as
// gentle as possible — but if the egress IP is blocked, a keyed backend
// (Tavily/Brave) is the reliable primary. See webSearch.ts.

const MIN_INTERVAL_MS = Number(process.env.DDG_MIN_INTERVAL_MS) || 2500;
const MAX_RETRIES = 3;
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { ts: number; results: SearchResult[] }>();
let lastCallAt = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAnomaly(msg: string): boolean {
  return /anomaly|too many|rate.?limit|429|blocked/i.test(msg);
}

export async function ddgWebSearch(query: string, maxResults = 6): Promise<SearchResult[]> {
  const key = `${maxResults}:${query}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.results;

  let attempt = 0;
  // Loop guarded by MAX_RETRIES; each anomaly backs off before the next try.
  for (;;) {
    // Polite pacing: never fire two DDG queries closer than MIN_INTERVAL_MS.
    const since = Date.now() - lastCallAt;
    if (since < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - since);
    lastCallAt = Date.now();

    try {
      const r = await ddgSearch(query, { safeSearch: SafeSearchType.MODERATE });
      const results: SearchResult[] = (r.results ?? []).slice(0, maxResults).map((x) => ({
        title: x.title ?? '',
        url: x.url ?? '',
        content: (x.description ?? '').replace(/<[^>]+>/g, '').trim(),
      })).filter((x) => x.url && x.title);
      cache.set(key, { ts: Date.now(), results });
      return results;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      attempt++;
      if (isAnomaly(msg) && attempt < MAX_RETRIES) {
        await sleep(MIN_INTERVAL_MS * Math.pow(2, attempt)); // exp backoff
        continue;
      }
      // Normalize so the research runner / managed loop recognizes this as a
      // search rate-limit and backs off, rather than hammering a blocked IP.
      if (isAnomaly(msg)) throw new Error(`DDG search rate limit / anomaly block: ${msg}`);
      throw new Error(`DDG search error: ${msg}`);
    }
  }
}
