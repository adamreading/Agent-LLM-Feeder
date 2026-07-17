import type pg from 'pg';
import { runCatalogSync, getLastSyncStatus } from './catalogSync.js';

// In-process daily scheduler for the catalog sync (Adam chose in-process over
// system cron: feeder has no supervisor/cron after a reboot). Design:
//   - persists last-run in settings.catalog_sync_last_run (via catalogSync);
//   - a lightweight hourly tick checks "has it been >= 24h?" and runs if so, so
//     a restart neither double-runs (the timestamp guards it) nor skips a day
//     (a day missed while feeder was down catches up on the next tick after boot);
//   - the first tick is delayed ~30s after boot so it never competes with serving
//     or with autoOnboard (which fires at ~8s), and runs in the background.
// Fail-soft: any error is swallowed inside runCatalogSync; the tick keeps ticking.

const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000; // hourly "is it due yet?" check
const FIRST_TICK_DELAY_MS = 30 * 1000;

let tickId: ReturnType<typeof setInterval> | null = null;
let firstTickId: ReturnType<typeof setTimeout> | null = null;

async function dueCheckAndRun(pool: pg.Pool): Promise<void> {
  try {
    const { lastRun } = await getLastSyncStatus(pool);
    const last = lastRun ? Date.parse(lastRun) : NaN;
    const due = !lastRun || Number.isNaN(last) || (Date.now() - last) >= DAY_MS;
    if (!due) return;
    console.log('[CatalogSync] daily sync due — running');
    await runCatalogSync(pool);
  } catch (err: any) {
    console.error('[CatalogSync] scheduler tick failed:', err?.message ?? err);
  }
}

export function startCatalogSyncScheduler(pool: pg.Pool): void {
  if (tickId) return;
  console.log('[CatalogSync] scheduler started (daily; hourly due-check)');
  firstTickId = setTimeout(() => { void dueCheckAndRun(pool); }, FIRST_TICK_DELAY_MS);
  tickId = setInterval(() => { void dueCheckAndRun(pool); }, TICK_MS);
}

export function stopCatalogSyncScheduler(): void {
  if (firstTickId) { clearTimeout(firstTickId); firstTickId = null; }
  if (tickId) { clearInterval(tickId); tickId = null; }
}
