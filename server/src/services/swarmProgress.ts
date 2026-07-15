// Zero-progress circuit-breaker for swarm sessions (RINGER, 2026-07-15).
//
// Root cause it defends against (verified in the requests log): a free/small
// worker model returns EMPTY completions, the OpenCode agent loop never
// converges, and with no step cap anywhere it resends the same ~21k-context
// hundreds of times. One observed session ran 252 rounds — 251 of them zero
// output — burning 6.16M tokens of pure spin. The real fix is an OpenCode
// step/turn cap (ringer's lane); this is feeder's BACKSTOP: the proxy is the one
// choke point that sees every worker call keyed by session, so it can detect the
// degenerate loop and kill it even when the harness has no bound.
//
// A round is "no-progress" when the model produced NO output AND essentially
// nothing was appended to the conversation since the last round (input barely
// grew). Real agentic work appends tool results (a file read, test output =
// hundreds-to-thousands of tokens) and/or produces output, so it never trips;
// the degenerate spin grows input by only ~tens of tokens/round with zero
// output. After LIMIT consecutive no-progress rounds the session is TRIPPED and
// the proxy refuses further calls for it (terminal — ringer stops the session).
//
// Invariants (mirror swarmBudget): swarm-consumers only, opt-in via a positive
// LIMIT, degrade-safe/fail-open (an untracked/idle session never blocks), all
// in-memory single-process. Keyed on session_id (OpenCode's per-invocation id =
// one agent loop), NOT run_id, because the loop lives inside a single session.

interface Progress {
  zeroStreak: number; // consecutive no-progress rounds
  lastInput: number;  // input_tokens of the previous round (to measure growth)
  tripped: boolean;
  lastUsed: number;
}

const sessions = new Map<string, Progress>(); // key = `${consumer}:${sessionId}`

// Consecutive no-progress rounds before a session is tripped. 0 disables the
// breaker entirely. Default 15 — well above the interspersed zero-output a
// HEALTHY session shows (8-36%, never 15 in a row) but far below the 250-round
// spins, so it kills a runaway early with negligible false-positive risk.
const LIMIT = Number(process.env.FEEDER_SWARM_NOPROGRESS_LIMIT ?? 15);

// A round only counts as no-progress if input grew by LESS than this since the
// previous round. Real tool results (file reads, test output) append far more,
// so a working session's streak resets; a spin (only a tiny nudge appended)
// stays under it. Guards against tripping legitimate tool-call-heavy turns that
// happen to log zero output.
const INPUT_DELTA_MIN = Number(process.env.FEEDER_SWARM_NOPROGRESS_INPUT_DELTA ?? 256);

// Forget a session after this much silence (session finished / abandoned).
const IDLE_MS = Number(process.env.FEEDER_SWARM_PROGRESS_IDLE_MS ?? 1_800_000); // 30 min

export function noProgressEnabled(): boolean {
  return LIMIT > 0;
}

function key(consumer: string, sessionId: string): string {
  return `${consumer.toLowerCase()}:${sessionId}`;
}

function prune(now: number): void {
  for (const [k, s] of sessions) {
    if (now - s.lastUsed > IDLE_MS) sessions.delete(k);
  }
}

/** Record a completed round's token shape. Called from logRequest for swarm
 *  sessions. Increments the no-progress streak on a degenerate round (no output
 *  + negligible input growth), resets it to 0 on any real round. */
export function recordProgress(
  consumer: string | null | undefined,
  sessionId: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): void {
  if (!noProgressEnabled() || !consumer || !sessionId) return;
  const now = Date.now();
  const k = key(consumer, sessionId);
  const prev = sessions.get(k) ?? { zeroStreak: 0, lastInput: 0, tripped: false, lastUsed: now };
  const inputDelta = inputTokens - prev.lastInput;
  const noProgress = (outputTokens ?? 0) <= 0 && inputDelta < INPUT_DELTA_MIN;
  const zeroStreak = noProgress ? prev.zeroStreak + 1 : 0;
  sessions.set(k, {
    zeroStreak,
    lastInput: inputTokens,
    tripped: zeroStreak >= LIMIT,
    lastUsed: now,
  });
  if (sessions.size > 5000) prune(now);
}

/** Pre-route gate. Returns {streak, limit} if this session has tripped the
 *  no-progress breaker (caller must reject), or null if it's fine. Never throws
 *  — fail-open by construction (disabled/untracked session → null). */
export function checkProgress(
  consumer: string | null | undefined,
  sessionId: string | null | undefined,
): { streak: number; limit: number } | null {
  if (!noProgressEnabled() || !consumer || !sessionId) return null;
  const s = sessions.get(key(consumer, sessionId));
  if (s?.tripped) return { streak: s.zeroStreak, limit: LIMIT };
  return null;
}

// Test-only: reset module state between cases.
export function _resetSwarmProgress(): void {
  sessions.clear();
}
