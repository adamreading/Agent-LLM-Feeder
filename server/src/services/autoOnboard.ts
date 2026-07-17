import type pg from 'pg';
import { probeNeverProbed, reprobeSuspects } from './probes/scheduler.js';
import { researchMissingCanonicals } from './modelResearch.js';

// Auto-onboard on arrival (Adam's ask): when a new model/supplier appears, it
// should get probed AND researched automatically — no manual step. New models
// arrive via the idempotent catalog migrations at startup (or a future UI/
// discovery add), so this runs once shortly after boot, in the BACKGROUND
// (never blocks the server coming up), and is naturally idempotent:
//   - a model with measured tools/json_mode rows no longer qualifies as
//     "never-probed", so probing is a no-op in steady state;
//   - a canonical model with a summary is skipped by research.
// Only genuine new arrivals / gaps trigger work. Safe to run every boot.

let running = false;

export async function autoOnboardNewArrivals(pool: pg.Pool): Promise<void> {
  if (running) return;
  running = true;
  const log = (m: string) => console.log(`[AutoOnboard] ${m}`);
  try {
    // 1. Probe suspect (regressed) + never-probed keyed models. Bounded to
    //    models we actually hold a key for (can't probe what we can't call).
    const suspects = await reprobeSuspects(pool, log);
    const probed = await probeNeverProbed(pool, log);
    if (suspects === 0 && probed === 0) log('no new/suspect models to probe');

    // 2. Research canonical models that have no summary yet (new arrivals).
    //    Unbounded at boot (fill in whatever's outstanding); skipped cleanly if
    //    no search backend/writer is configured. Shared with the daily
    //    catalogSync (which caps its pass at 10/day).
    await researchMissingCanonicals(pool, { log });
  } catch (err: any) {
    log(`error: ${err?.message ?? err}`);
  } finally {
    running = false;
  }
}
