import type { SearchResult } from './webSearch.js';

// Short-TTL shared search cache (RINGER, 2026-07-17). A swarm fans out N workers
// that each run ~M agentic steps, and with augment=force every step hits the
// search backend — 6 workers × ~10 steps = ~60 live searches for one run, which
// self-exhausts a free-tier hourly cap mid-run (Ollama). Feeder is the single
// choke point that sees EVERY worker's search, so a tiny in-process cache keyed
// on the query text dedups identical/near-identical queries across workers, steps
// AND concurrent runs — turning a burst of ~60 into a handful of real calls.
//
// Keyed on the ACTUAL normalized query (not per-session), so it never injects
// stale grounding for a different question — a cache HIT means the same query was
// searched moments ago, which is exactly when reuse is correct. Only non-empty
// result sets are cached (an empty result re-searches, in case it was transient).
// Fully degrade-safe: a miss is just the normal search path. In-memory, bounded.

const TTL_MS = Number(process.env.FEEDER_SEARCH_CACHE_TTL_MS ?? 600_000); // 10 min; 0 = disabled
const MAX_ENTRIES = Number(process.env.FEEDER_SEARCH_CACHE_MAX ?? 500);

interface Entry { results: SearchResult[]; expires: number }
const cache = new Map<string, Entry>(); // insertion-ordered → cheap LRU-ish eviction

function normalize(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 400);
}

/** Cached results for this query if still fresh, else null (a miss). */
export function getCachedSearch(query: string): SearchResult[] | null {
  if (TTL_MS <= 0) return null;
  const key = normalize(query);
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { cache.delete(key); return null; }
  // Refresh recency (move to newest) so hot queries survive eviction.
  cache.delete(key);
  cache.set(key, e);
  return e.results;
}

/** Cache a NON-EMPTY result set. Empty sets are never cached (may be transient). */
export function setCachedSearch(query: string, results: SearchResult[]): void {
  if (TTL_MS <= 0) return;
  if (!results || results.length === 0) return;
  const key = normalize(query);
  cache.set(key, { results, expires: Date.now() + TTL_MS });
  // Evict oldest entries past the cap (Map preserves insertion order).
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// Test-only: reset between cases.
export function _resetSearchCache(): void {
  cache.clear();
}
