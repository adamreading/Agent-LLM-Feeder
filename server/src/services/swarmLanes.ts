// Swarm lane tracking for hard provider anti-affinity (RINGER, design locked
// 2026-07-14). When a parallel task-runner fans out N workers through /v1,
// same-class workers otherwise all score the SAME top model and converge on one
// provider — which rate-limits under the concurrent load (observed live: 3
// workers → 2× SambaNova 429 in the Phase-3 demo). This module lets the proxy
// spread each worker onto a DISTINCT platform and hold it for the worker's job.
//
// A "lane" = one session's currently-assigned platform. We track, per active
// swarm session, which platform it holds; a new worker's first routing call
// then excludes platforms held by its siblings (see swarmExcludeProviders in
// router.ts). All in-memory + single-process — but NOT lock-free: the assign is
// read-held → await routeRequest → record, and the read/write straddle the
// await, so N simultaneous first-calls would each read a stale (empty) held-set
// and collide. withAssignLock serialises the first-call critical section.

interface Lane {
  platform: string;
  consumer: string;
  lastUsed: number;
}

const lanes = new Map<string, Lane>(); // sessionKey -> lane

// Which consumers participate in swarm anti-affinity (grouped separately — a
// session only anti-affines against OTHER sessions of the same consumer, so two
// distinct swarm apps don't fight over the same providers). Configurable.
const SWARM_CONSUMERS = new Set(
  (process.env.FEEDER_SWARM_CONSUMERS ?? 'ringer')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
);

// A lane is released after this much inter-call silence. Deliberately LONG
// (Adam/WSL/ringer consensus): a live-but-slow worker can go minutes between
// LLM calls mid-attempt (long test run, big read, model thinking) and must NOT
// lose its platform; an over-held lane only makes capacity mildly conservative
// (cheap), whereas a short window self-inflicts the mid-attempt provider loss +
// prompt-cache thrash the anti-affinity exists to prevent. Refreshed on every
// call. Tighten later by calibrating from p95 inter-call gap in `requests`.
const LANE_IDLE_MS = Number(process.env.FEEDER_SWARM_LANE_IDLE_MS ?? 300_000);

export function isSwarmConsumer(consumer: string | null | undefined): boolean {
  return !!consumer && SWARM_CONSUMERS.has(consumer.toLowerCase());
}

function live(lane: Lane, now: number): boolean {
  return now - lane.lastUsed <= LANE_IDLE_MS;
}

// Drop idle lanes. Called on every read so held-sets never count a dead worker.
function prune(now: number): void {
  for (const [key, lane] of lanes) {
    if (!live(lane, now)) lanes.delete(key);
  }
}

/** Does this session already hold a live lane? (i.e. NOT a first-call.) */
export function hasLane(sessionKey: string): boolean {
  const lane = lanes.get(sessionKey);
  return !!lane && live(lane, Date.now());
}

/** Platforms held by OTHER live sessions of the same swarm consumer — the set a
 *  new/re-pinning worker must avoid. */
export function heldPlatformsExcluding(sessionKey: string, consumer: string): Set<string> {
  const now = Date.now();
  prune(now);
  const out = new Set<string>();
  for (const [key, lane] of lanes) {
    if (key === sessionKey) continue;
    if (lane.consumer.toLowerCase() !== consumer.toLowerCase()) continue;
    out.add(lane.platform);
  }
  return out;
}

/** Every platform currently held by a live swarm session (any swarm consumer) —
 *  used by the capacity endpoint to report FREE lanes. */
export function heldPlatforms(): Set<string> {
  const now = Date.now();
  prune(now);
  const out = new Set<string>();
  for (const lane of lanes.values()) out.add(lane.platform);
  return out;
}

/** Record/refresh a session's assigned platform. Called after every successful
 *  route for a swarm session (refreshes lastUsed + tracks re-pins). */
export function recordLane(sessionKey: string, consumer: string, platform: string): void {
  lanes.set(sessionKey, { platform, consumer, lastUsed: Date.now() });
  if (lanes.size > 2000) prune(Date.now()); // backstop against unbounded growth
}

// ── Assign lock ──────────────────────────────────────────────────────────
// A single process-wide async mutex. First-call assignments (compute-exclusion
// → route → record) run one at a time so a concurrent sibling sees the prior
// assignment before computing its own exclusion. First-calls are once-per-worker
// and the critical section is just routing (DB, no LLM call), so global
// serialisation is cheap. A rejection never breaks the chain for later waiters.
let chain: Promise<unknown> = Promise.resolve();
export function withAssignLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

// Test-only: reset module state between cases.
export function _resetSwarmLanes(): void {
  lanes.clear();
  chain = Promise.resolve();
}
