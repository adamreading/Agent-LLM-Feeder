import { getPool } from '../db/index.js';
import { all, run } from '../db/pgCompat.js';
import { getBackendById, type SearchResult } from './webSearch.js';
import { getSearchPool, isPaidBackend, getFreeQuota } from './searchConfig.js';

// Load-balanced search pool (RINGER incident fix, 2026-07-17). Search used to hit
// ONE active backend, which rate-limited under a burst (Ollama free-tier exhausted
// mid-run). This spreads search across a BANK of activated FREE engines — like the
// model router spreads across providers — so no single free engine gets hammered,
// tracks per-engine latency/health, and falls through to a PAID last-resort tier
// (You.com) only when every free engine is exhausted, guarded by per-job + global
// spend caps. Degrade-safe: a fully-exhausted bank returns [] and the caller
// proceeds unaugmented with an honest reason.

export type SearchSkipReason = 'throttled' | 'no-results' | 'no-config' | 'error';
export interface PoolSearchResult {
  results: SearchResult[];
  reason: SearchSkipReason | null; // null on success (results returned)
  backend: string | null;         // which engine served the results
}

const THROTTLE_RE = /429|rate.?limit|too many requests|quota|exhaust|throttl|capacity|overloaded|insufficient/i;
const COOLDOWN_THROTTLE_MS = Number(process.env.FEEDER_SEARCH_COOLDOWN_THROTTLE_MS ?? 600_000); // 10 min
const COOLDOWN_ERROR_MS = Number(process.env.FEEDER_SEARCH_COOLDOWN_ERROR_MS ?? 60_000);        // 1 min
const ENGINE_TIMEOUT_MS = Number(process.env.FEEDER_SEARCH_ENGINE_TIMEOUT_MS ?? 6_000);         // per-engine

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('search engine timeout')), ms))]);
}

// You.com spend guards (Adam, 2026-07-17): per-JOB (run_id) cutoff is the primary
// guard; global ceiling is the total-credit backstop. $5 job / $180 global by default.
const YOU_COST_PER_CALL = 0.005; // $5 / 1000 calls
const YOU_JOB_CAP_USD = Number(process.env.FEEDER_YOU_JOB_CAP_USD ?? 5);
const YOU_GLOBAL_CAP_USD = Number(process.env.FEEDER_YOU_SPEND_CAP_USD ?? 180);

// In-mem per-job You.com call counter, keyed on run_id. A restart resets it (the
// global DB counter is the durable backstop). Mirrors swarmBudget's per-run meter.
const youCallsByJob = new Map<string, number>();

interface HealthRow {
  backend: string; recent_latency_ms: number | null; success_count: number; fail_count: number;
  consecutive_failures: number; calls_total: number; cooldown_until: string | null;
  last_error: string | null; last_used_at: string | null;
  period_calls: number; period_start: string | null;
}

// Remaining free-tier quota for an engine (Infinity if uncapped). 'total'-period
// quotas draw down against lifetime calls_total; 'month' against period_calls.
function remainingQuota(id: string, h: HealthRow | undefined): number {
  const q = getFreeQuota(id);
  if (!q) return Infinity;
  const used = q.period === 'total' ? (h?.calls_total ?? 0) : (h?.period_calls ?? 0);
  return q.limit - used;
}
function headroomFraction(id: string, h: HealthRow | undefined): number {
  const q = getFreeQuota(id);
  if (!q) return 1; // uncapped = full headroom
  return remainingQuota(id, h) / q.limit;
}
const LOW_HEADROOM = Number(process.env.FEEDER_SEARCH_LOW_HEADROOM ?? 0.15);

async function loadHealth(): Promise<Map<string, HealthRow>> {
  const rows = await all<HealthRow>(getPool(), `SELECT * FROM search_backend_health`);
  return new Map(rows.map((r) => [r.backend, r]));
}

// Monthly-window SQL: reset period_calls to 1 when the stored period_start is
// null or in a prior calendar month, else increment. Same expression in both
// branches so every attempt draws down the quota window.
const PERIOD_CALLS = `CASE WHEN search_backend_health.period_start IS NULL OR date_trunc('month', search_backend_health.period_start) < date_trunc('month', now()) THEN 1 ELSE search_backend_health.period_calls + 1 END`;
const PERIOD_START = `CASE WHEN search_backend_health.period_start IS NULL OR date_trunc('month', search_backend_health.period_start) < date_trunc('month', now()) THEN now() ELSE search_backend_health.period_start END`;

async function recordAttempt(backend: string, ok: boolean, latencyMs: number, opts: { error?: string; throttled?: boolean } = {}): Promise<void> {
  const now = new Date().toISOString();
  if (ok) {
    await run(getPool(), `
      INSERT INTO search_backend_health (backend, recent_latency_ms, success_count, calls_total, period_calls, period_start, consecutive_failures, cooldown_until, last_used_at, updated_at)
      VALUES (?, ?, 1, 1, 1, now(), 0, NULL, ?, now())
      ON CONFLICT (backend) DO UPDATE SET
        recent_latency_ms = EXCLUDED.recent_latency_ms,
        success_count = search_backend_health.success_count + 1,
        calls_total = search_backend_health.calls_total + 1,
        period_calls = ${PERIOD_CALLS}, period_start = ${PERIOD_START},
        consecutive_failures = 0, cooldown_until = NULL,
        last_used_at = EXCLUDED.last_used_at, updated_at = now()
    `, [backend, latencyMs > 0 ? latencyMs : null, now]);
  } else {
    const cooldownMs = opts.throttled ? COOLDOWN_THROTTLE_MS : COOLDOWN_ERROR_MS;
    const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
    await run(getPool(), `
      INSERT INTO search_backend_health (backend, fail_count, calls_total, period_calls, period_start, consecutive_failures, cooldown_until, last_error, last_used_at, updated_at)
      VALUES (?, 1, 1, 1, now(), 1, ?, ?, ?, now())
      ON CONFLICT (backend) DO UPDATE SET
        fail_count = search_backend_health.fail_count + 1,
        calls_total = search_backend_health.calls_total + 1,
        period_calls = ${PERIOD_CALLS}, period_start = ${PERIOD_START},
        consecutive_failures = search_backend_health.consecutive_failures + 1,
        cooldown_until = ?, last_error = EXCLUDED.last_error,
        last_used_at = EXCLUDED.last_used_at, updated_at = now()
    `, [backend, cooldownUntil, (opts.error ?? '').slice(0, 200), now, cooldownUntil]);
  }
}

function cooled(h: HealthRow | undefined, nowMs: number): boolean {
  return !!h?.cooldown_until && Date.parse(h.cooldown_until) > nowMs;
}
// LRU: never-used first (null last_used_at), then oldest last_used_at.
function lruSort(ids: string[], health: Map<string, HealthRow>): string[] {
  return [...ids].sort((a, b) => {
    const ta = health.get(a)?.last_used_at, tb = health.get(b)?.last_used_at;
    if (!ta && !tb) return 0;
    if (!ta) return -1;
    if (!tb) return 1;
    return Date.parse(ta) - Date.parse(tb);
  });
}
function configured(id: string): boolean {
  return !!getBackendById(id)?.isConfigured();
}

// Try one engine; returns results on success, or null (with reason set on `out`) to try the next.
async function tryEngine(id: string, query: string, max: number, out: { reason: SearchSkipReason | null }): Promise<SearchResult[] | null> {
  const backend = getBackendById(id);
  if (!backend) return null;
  const start = Date.now();
  try {
    const results = await withTimeout(backend.search(query, max), ENGINE_TIMEOUT_MS);
    const lat = Date.now() - start;
    await recordAttempt(id, true, lat);
    if (results && results.length) return results;
    out.reason = 'no-results';
    return null;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    const throttled = THROTTLE_RE.test(msg);
    await recordAttempt(id, false, 0, { error: msg, throttled });
    out.reason = throttled ? 'throttled' : 'error';
    return null;
  }
}

export async function poolSearch(query: string, maxResults = 6, opts: { runId?: string | null } = {}): Promise<PoolSearchResult> {
  const pool = await getSearchPool(getPool());
  const health = await loadHealth();
  const nowMs = Date.now();
  const out: { reason: SearchSkipReason | null } = { reason: null };

  // FREE tier, quota-aware: drop engines that are cooled or quota-EXHAUSTED, then
  // spread LRU within a headroom BAND — high-headroom engines carry the load
  // (even LRU spread among them); a near-exhausted engine (< LOW_HEADROOM of its
  // free quota left) drops to a secondary band, used only if the high band is
  // unavailable — so a small free tier (e.g. serpapi 100/mo) keeps its last
  // credits instead of being drained by the even spread.
  const freeConfigured = pool.filter((id) => !isPaidBackend(id) && configured(id));
  const freeEligible = freeConfigured.filter((id) => !cooled(health.get(id), nowMs) && remainingQuota(id, health.get(id)) > 0);
  const highBand = lruSort(freeEligible.filter((id) => headroomFraction(id, health.get(id)) >= LOW_HEADROOM), health);
  const lowBand = lruSort(freeEligible.filter((id) => headroomFraction(id, health.get(id)) < LOW_HEADROOM), health);
  const freeReady = [...highBand, ...lowBand];

  // FREE tier — even LRU spread; skip cooled engines.
  for (const id of freeReady) {
    const r = await tryEngine(id, query, maxResults, out);
    if (r) return { results: r, reason: null, backend: id };
  }

  // If nothing configured in the free tier at all, that's a config gap (unless a
  // paid fallback is configured, handled below).
  if (freeConfigured.length === 0) out.reason = out.reason ?? 'no-config';
  // If free engines existed but were ALL in cooldown (none tried this call), the
  // honest reason is throttled — the bank is rate-limited right now.
  else if (freeReady.length === 0 && out.reason === null) out.reason = 'throttled';

  // FALLBACK tier — PAID last-resort (You.com), only reached when free is exhausted.
  const paidReady = lruSort(pool.filter((id) => isPaidBackend(id) && configured(id) && !cooled(health.get(id), nowMs)), health);
  for (const id of paidReady) {
    // Global cap (durable, DB-backed): total lifetime spend on this paid engine.
    const spent = (health.get(id)?.calls_total ?? 0) * YOU_COST_PER_CALL;
    if (spent >= YOU_GLOBAL_CAP_USD) { out.reason = out.reason ?? 'throttled'; continue; }
    // Per-job cap (in-mem, run_id-keyed): $5 per job. No run_id ⇒ can't meter a
    // job, so only the global cap applies.
    if (opts.runId) {
      const jobSpent = (youCallsByJob.get(opts.runId) ?? 0) * YOU_COST_PER_CALL;
      if (jobSpent >= YOU_JOB_CAP_USD) { out.reason = out.reason ?? 'throttled'; continue; }
      youCallsByJob.set(opts.runId, (youCallsByJob.get(opts.runId) ?? 0) + 1); // count the attempt (conservative)
    }
    const r = await tryEngine(id, query, maxResults, out);
    if (r) return { results: r, reason: null, backend: id };
  }

  return { results: [], reason: out.reason ?? 'no-results', backend: null };
}

/** Per-engine telemetry for the UI: adds paid est-spend + free-tier quota/remaining. */
export async function getSearchHealth(): Promise<Array<HealthRow & { paid: boolean; estSpendUsd: number | null; quotaLimit: number | null; quotaPeriod: string | null; remaining: number | null }>> {
  const health = await loadHealth();
  const pool = await getSearchPool(getPool());
  const ids = Array.from(new Set([...pool, ...health.keys()]));
  return ids.map((id) => {
    const h = health.get(id) ?? { backend: id, recent_latency_ms: null, success_count: 0, fail_count: 0, consecutive_failures: 0, calls_total: 0, cooldown_until: null, last_error: null, last_used_at: null, period_calls: 0, period_start: null };
    const paid = isPaidBackend(id);
    const q = getFreeQuota(id);
    const rem = remainingQuota(id, h);
    return {
      ...h, paid,
      estSpendUsd: paid ? Number((h.calls_total * YOU_COST_PER_CALL).toFixed(2)) : null,
      quotaLimit: q ? q.limit : null,
      quotaPeriod: q ? q.period : null,
      remaining: Number.isFinite(rem) ? Math.max(0, rem) : null,
    };
  });
}

export const YOU_CAPS = { costPerCall: YOU_COST_PER_CALL, jobCapUsd: YOU_JOB_CAP_USD, globalCapUsd: YOU_GLOBAL_CAP_USD };

// Test-only.
export function _resetJobSpend(): void { youCallsByJob.clear(); }
