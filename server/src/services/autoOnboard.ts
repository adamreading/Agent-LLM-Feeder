import type pg from 'pg';
import { all } from '../db/pgCompat.js';
import { probeNeverProbed, reprobeSuspects } from './probes/scheduler.js';
import { researchWriterAvailable, researchCanonicalModel, recordResearch } from './modelResearch.js';
import { searchConfigured } from './webSearch.js';

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
    //    Skipped cleanly if no search backend/writer is configured.
    const missing = await all<{ id: number; name: string }>(pool, `
      SELECT id, name FROM canonical_models WHERE summary IS NULL OR summary = '' ORDER BY name ASC
    `);
    if (missing.length === 0) { log('no un-researched canonical models'); return; }
    if (!searchConfigured()) { log(`${missing.length} un-researched models, but no web-search backend configured — skipping research`); return; }
    if (!(await researchWriterAvailable(pool))) { log(`${missing.length} un-researched models, but no writer model available — skipping research`); return; }

    log(`researching ${missing.length} new canonical model(s) via auto/research`);
    for (const c of missing) {
      try {
        const res = await researchCanonicalModel(pool, c.id);
        if (res.summary || Object.keys(res.tasks).length) {
          await recordResearch(pool, c.id, res);
          log(`researched ${c.name}`);
        }
      } catch (err: any) {
        // A tagged SEARCH rate-limit stops the pass (fills in on next boot/run);
        // a writer error just skips that model.
        if (err?.isSearchError) { log(`search rate-limited — stopping research pass (resumes next run)`); break; }
        log(`research failed for ${c.name}: ${err?.message ?? err}`);
      }
    }
  } catch (err: any) {
    log(`error: ${err?.message ?? err}`);
  } finally {
    running = false;
  }
}
