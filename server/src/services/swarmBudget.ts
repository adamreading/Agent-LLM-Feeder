// Per-run token hard-cap enforcer for swarm consumers (RINGER, 2026-07-15).
//
// A swarm run fans out many worker calls through /v1 (consumer='ringer'), each
// tagged with the run's id on the `X-Run-Id` header. Because the workers are
// free-tier resource the ceiling is a RUNAWAY BACKSTOP, not rationing: once a
// run's cumulative tokens cross a budget it DECLARED at start, feeder refuses
// further calls for that run with a terminal 429 (`run_budget_exceeded`) — the
// only choke point that sees every worker token and can 429 at the boundary.
//
// Design invariants (contract locked with ringer 2026-07-15):
//  • OPT-IN — a run with no declared budget is unlimited (today's behaviour).
//    Enforcement exists only after POST /api/swarm/budget declares a ceiling.
//  • SET-ONCE / LOWER-ONLY — a second declare for the same run may only LOWER
//    the ceiling, never raise it, so neither the orchestrator nor a worker can
//    uncap a run mid-flight.
//  • DEGRADE-SAFE / FAIL-OPEN — an untracked run (never declared, or lost to a
//    feeder restart) is unlimited. The enforcer only ever ADDS a stop; a
//    missing budget never blocks legitimate traffic.
//  • BOUNDED OVERSHOOT (honest) — tokens are booked when a call COMPLETES
//    (recordSpend in logRequest), so N concurrent in-flight calls can each pass
//    the pre-route check then collectively overshoot by up to one in-flight
//    wave. Fine for a backstop; cap --max-parallel for tighter bounds. Not a
//    to-the-token meter.
//
// All in-memory + single-process (like swarmLanes). The requests log is the
// source of truth: the counter is SEEDED from it on declare / cold-start so a
// re-declare after a restart resumes from real spend, not zero.
import type pg from 'pg';
import { all } from '../db/pgCompat.js';

interface RunBudget {
  budget: number; // max cumulative tokens for the run
  spent: number;  // cumulative input+output tokens booked so far
  lastUsed: number;
}

const runs = new Map<string, RunBudget>(); // key = `${consumer}:${runId}`

// A declared budget is forgotten after this much silence, so a finished run's
// entry doesn't live forever. Long, matching the swarm lane idle window: a
// slow run can go minutes between calls and must keep its cap.
const RUN_IDLE_MS = Number(process.env.FEEDER_SWARM_RUN_IDLE_MS ?? 1_800_000); // 30 min

function key(consumer: string, runId: string): string {
  return `${consumer.toLowerCase()}:${runId}`;
}

function prune(now: number): void {
  for (const [k, r] of runs) {
    if (now - r.lastUsed > RUN_IDLE_MS) runs.delete(k);
  }
}

/** Sum of real (non-probe) input+output tokens already logged for this run.
 *  Seeds the in-memory counter so a declare after a restart / after some calls
 *  already ran resumes from actual spend. */
async function seedSpentFromLog(pool: pg.Pool, consumer: string, runId: string): Promise<number> {
  try {
    const rows = await all<{ spent: string | number | null }>(pool, `
      SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS spent
      FROM requests
      WHERE consumer = ? AND run_id = ? AND is_probe = false
    `, [consumer, runId]);
    const v = Number(rows[0]?.spent ?? 0);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0; // fail-open: a seed failure must never block declaring a cap
  }
}

/** Declare (or lower) a run's token ceiling. Set-once + lower-only. Returns the
 *  effective {budget, spent} after applying the rule. */
export async function declareBudget(
  pool: pg.Pool, consumer: string, runId: string, maxTokens: number,
): Promise<{ budget: number; spent: number }> {
  const now = Date.now();
  prune(now);
  const k = key(consumer, runId);
  const existing = runs.get(k);
  const spent = existing ? existing.spent : await seedSpentFromLog(pool, consumer, runId);
  // Lower-only: an existing ceiling can only be reduced, never raised.
  const budget = existing ? Math.min(existing.budget, maxTokens) : maxTokens;
  runs.set(k, { budget, spent, lastUsed: now });
  if (runs.size > 5000) prune(now); // backstop against unbounded growth
  return { budget, spent };
}

/** Pre-route gate. Returns {spent, budget} if this run is OVER its declared
 *  budget (caller must reject), or null if allowed (no budget declared, or
 *  still under). Never throws — fail-open by construction. */
export function checkBudget(consumer: string, runId: string): { spent: number; budget: number } | null {
  const r = runs.get(key(consumer, runId));
  if (!r) return null;                 // opt-in: no declared budget → unlimited
  r.lastUsed = Date.now();
  if (r.spent >= r.budget) return { spent: r.spent, budget: r.budget };
  return null;
}

/** Book tokens against a run. Called from logRequest on every completed call.
 *  No-op for untracked runs (no declared budget) — cheap on the hot path. */
export function recordSpend(consumer: string | null | undefined, runId: string | null | undefined, tokens: number): void {
  if (!consumer || !runId || !Number.isFinite(tokens) || tokens <= 0) return;
  const r = runs.get(key(consumer, runId));
  if (!r) return; // only meter runs that declared a budget
  r.spent += tokens;
  r.lastUsed = Date.now();
}

/** Inspect a run's current budget state (for the endpoint's response / tests). */
export function peekBudget(consumer: string, runId: string): { spent: number; budget: number } | null {
  const r = runs.get(key(consumer, runId));
  return r ? { spent: r.spent, budget: r.budget } : null;
}

// Test-only: reset module state between cases.
export function _resetSwarmBudget(): void {
  runs.clear();
}
