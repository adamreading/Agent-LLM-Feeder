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
    //    BOUNDED per boot (FEEDER_ONBOARD_RESEARCH_LIMIT, default 20) — was
    //    unbounded, which burned ~284 free-tier search credits on 2026-07-17 when
    //    a big new-canonical backlog met ~8 restarts (each boot chewed the whole
    //    backlog). The daily catalogSync (cap 10) clears the rest over days, so a
    //    restart can no longer trigger a large search spend. Skipped cleanly if no
    //    search backend/writer is configured.
    const bootLimit = Number(process.env.FEEDER_ONBOARD_RESEARCH_LIMIT ?? 20);
    await researchMissingCanonicals(pool, { log, limit: bootLimit });
  } catch (err: any) {
    log(`error: ${err?.message ?? err}`);
  } finally {
    running = false;
  }
}
