import type pg from 'pg';
import { runLeaderboardSync, getLastLeaderboardStatus } from './leaderboardSync.js';

// In-process WEEKLY scheduler for the zero-token leaderboard import — same
// shape as catalogSyncScheduler (persisted last-run in settings, hourly
// due-check, restart-safe). Weekly because leaderboards move slowly and the
// whole point is to keep the quality prior free: 8 arena GETs + 1 AA GET.
// Never runs a second pass in parallel (runLeaderboardSync guards itself).
// Override the period with FEEDER_LEADERBOARD_PERIOD_HOURS (default 168).

const PERIOD_MS = Number(process.env.FEEDER_LEADERBOARD_PERIOD_HOURS ?? 168) * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 60 * 1000; // after autoOnboard (8s) and catalogSync's first tick (30s)

let tickId: ReturnType<typeof setInterval> | null = null;
let firstTickId: ReturnType<typeof setTimeout> | null = null;

async function dueCheckAndRun(pool: pg.Pool): Promise<void> {
  try {
    const { lastRun } = await getLastLeaderboardStatus(pool);
    const last = lastRun ? Date.parse(lastRun) : NaN;
    const due = !lastRun || Number.isNaN(last) || (Date.now() - last) >= PERIOD_MS;
    if (!due) return;
    console.log('[LeaderboardSync] weekly import due — running');
    await runLeaderboardSync(pool);
  } catch (err: any) {
    console.error('[LeaderboardSync] scheduler tick failed:', err?.message ?? err);
  }
}

export function startLeaderboardSyncScheduler(pool: pg.Pool): void {
  if (tickId) return;
  console.log(`[LeaderboardSync] scheduler started (every ${Math.round(PERIOD_MS / 3600000)}h; hourly due-check)`);
  firstTickId = setTimeout(() => { void dueCheckAndRun(pool); }, FIRST_TICK_DELAY_MS);
  tickId = setInterval(() => { void dueCheckAndRun(pool); }, TICK_MS);
}

export function stopLeaderboardSyncScheduler(): void {
  if (firstTickId) { clearTimeout(firstTickId); firstTickId = null; }
  if (tickId) { clearInterval(tickId); tickId = null; }
}
