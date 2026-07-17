import type pg from 'pg';
import { all, get, run } from '../db/pgCompat.js';
import { discoverLiveModels, isTrustworthyPoll, type DiscoveryResult } from './catalogDiscovery.js';
import { classifyModelKind } from './modelKind.js';
import { matchModels, createCanonicalFromModel } from './modelCanon.js';
import { livenessEnablePending } from './livenessEnable.js';
import { researchMissingCanonicals } from './modelResearch.js';

// Daily catalog sync (Adam, 2026-07-17): the automated equivalent of manually
// running discover-models.ts + hand-writing a catalog migration. Once a day it
// polls every provider's LIVE model list and reconciles the catalog + wiki:
//   1. DISCOVER  — GET /models per enabled key (free, no completion tokens).
//   2. ADD       — insert unseen ids as enabled=false 'pending-liveness (daily-sync)'.
//   3. MARK/RETIRE — for platforms that polled OK: refresh last_seen_live for
//      present ids; increment missing_polls for previously-live ids now absent;
//      SOFT-RETIRE (enabled=false, disabled_reason='delisted') after
//      `retireThreshold` consecutive misses. A failed/empty poll touches NOTHING
//      (a provider blip can't retire a model). Reappearance un-retires.
//   4. MATCH     — link new rows to canonical models; create a canonical (wiki
//      entry) for each newly-added *chat* model still unmatched.
//   5. ENABLE    — bounded liveness pass flips working new models to enabled=true
//      (only enabled instances show in the wiki / route). Capped per run.
//   6. RESEARCH  — bounded pass writes wiki summaries for new canonicals. Capped.
//
// Stages 5 + 6 are the only token-touching stages and are BOTH capped; discovery
// is free. Soft-retire only — the row + its paid-for research + slug/links are
// preserved and it returns to the wiki if the model reappears + re-passes liveness.

export interface CatalogSyncOptions {
  researchLimit?: number;   // max new canonicals to research this run (default 10)
  enableLimit?: number;     // max pending models to liveness-test this run (default 15)
  retireThreshold?: number; // consecutive missed polls before soft-retire (default 3)
  log?: (m: string) => void;
}

export interface CatalogSyncSummary {
  startedAt: string;
  finishedAt: string;
  platforms: Record<string, { status: number; live: number; trustworthy: boolean; err?: string }>;
  added: number;
  reappeared: number;
  retired: number;
  enabled: number;
  researched: number;
  canonicalsCreated: number;
  note?: string;
}

// Reasons owned by OTHER auto-disable mechanisms — never overridden by retirement
// (schema.ts disabled_reason ownership rule). We only retire rows that are live
// (enabled) or in our own pending/delisted states.
const RETIRE_ELIGIBLE = `(enabled = true OR disabled_reason LIKE 'pending-liveness%' OR disabled_reason = 'delisted')`;

let running = false;

function titleCase(id: string): string {
  const leaf = (id.split('/').pop() ?? id).replace(/:free$/, '');
  return leaf.replace(/[-_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

export async function runCatalogSync(pool: pg.Pool, opts: CatalogSyncOptions = {}): Promise<CatalogSyncSummary> {
  const log = opts.log ?? ((m: string) => console.log(`[CatalogSync] ${m}`));
  const researchLimit = opts.researchLimit ?? 10;
  const enableLimit = opts.enableLimit ?? 15;
  const retireThreshold = Math.max(1, opts.retireThreshold ?? 3);
  const startedAt = new Date().toISOString();

  const summary: CatalogSyncSummary = {
    startedAt, finishedAt: startedAt, platforms: {}, added: 0, reappeared: 0,
    retired: 0, enabled: 0, researched: 0, canonicalsCreated: 0,
  };
  if (running) { summary.note = 'already running — skipped'; return summary; }
  running = true;

  try {
    // 1. DISCOVER (free)
    const discovery: DiscoveryResult = await discoverLiveModels(pool);
    const newlyAddedIds: number[] = [];

    for (const [platform, d] of Object.entries(discovery)) {
      const trustworthy = isTrustworthyPoll(d);
      summary.platforms[platform] = { status: d.status, live: d.ids.length, trustworthy, err: d.err };
      if (!trustworthy) {
        log(`${platform}: poll not trustworthy (HTTP ${d.status}, ${d.ids.length} ids)${d.err ? ' — ' + d.err : ''} — skipping add/retire`);
        continue;
      }
      // Dedupe the live list — some providers list the same id twice in one
      // /models response, which would otherwise self-collide on insert.
      const liveIds = Array.from(new Set(d.ids));

      // 2. ADD unseen ids. ON CONFLICT DO NOTHING makes this robust to a
      //    provider dup-listing OR a concurrent run — a collision skips that row
      //    instead of aborting the whole sync (returns no id → not counted).
      const existing = await all<{ model_id: string }>(pool, `SELECT model_id FROM models WHERE platform = ?`, [platform]);
      const existingSet = new Set(existing.map((e) => e.model_id));
      for (const modelId of liveIds) {
        if (existingSet.has(modelId)) continue;
        const name = titleCase(modelId);
        const row = await get<{ id: number }>(pool, `
          INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, cost_tier, disabled_reason, match_status, kind, last_seen_live, missing_polls)
          VALUES (?, ?, ?, 500, 500, false, 'free', 'pending-liveness (daily-sync)', 'unmatched', ?, now(), 0)
          ON CONFLICT (platform, model_id) DO NOTHING
          RETURNING id
        `, [platform, modelId, name, classifyModelKind(modelId, name)]);
        if (row?.id) { newlyAddedIds.push(row.id); summary.added++; }
      }

      // 3a. Reappearance: a delisted model back in the live list re-enters liveness.
      const reappeared = await run(pool, `
        UPDATE models SET disabled_reason = 'pending-liveness (reappeared daily-sync)'
        WHERE platform = ? AND disabled_reason = 'delisted' AND model_id = ANY(?::text[])
      `, [platform, liveIds]);
      summary.reappeared += reappeared.changes;

      // 3b. Mark present ids as seen (reset the miss counter).
      await run(pool, `
        UPDATE models SET last_seen_live = now(), missing_polls = 0
        WHERE platform = ? AND model_id = ANY(?::text[])
      `, [platform, liveIds]);

      // 3c. Increment the miss counter for previously-live ids now absent.
      await run(pool, `
        UPDATE models SET missing_polls = missing_polls + 1
        WHERE platform = ? AND last_seen_live IS NOT NULL
          AND NOT (model_id = ANY(?::text[])) AND ${RETIRE_ELIGIBLE}
      `, [platform, liveIds]);

      // 3d. Soft-retire ids that have now missed the threshold consecutively.
      const retired = await run(pool, `
        UPDATE models SET enabled = false, disabled_reason = 'delisted'
        WHERE platform = ? AND last_seen_live IS NOT NULL
          AND NOT (model_id = ANY(?::text[])) AND missing_polls >= ? AND ${RETIRE_ELIGIBLE}
      `, [platform, liveIds, retireThreshold]);
      summary.retired += retired.changes;
    }

    log(`discovery: +${summary.added} new, ${summary.reappeared} reappeared, ${summary.retired} retired`);

    // 4. MATCH new rows to canonicals; create a wiki entry for each new CHAT
    //    model still unmatched (leaves the existing manual review queue alone —
    //    only touches rows we added this run).
    if (newlyAddedIds.length) {
      await matchModels(pool);
      const unmatchedNew = await all<{ id: number }>(pool, `
        SELECT id FROM models WHERE id = ANY(?::int[]) AND canonical_model_id IS NULL AND kind = 'chat'
      `, [newlyAddedIds]);
      for (const m of unmatchedNew) {
        try { await createCanonicalFromModel(pool, m.id); summary.canonicalsCreated++; }
        catch (err: any) { log(`canonical create failed for model ${m.id}: ${err?.message ?? err}`); }
      }
      log(`matched new rows; created ${summary.canonicalsCreated} canonical wiki entries`);
    }

    // 5. ENABLE working new models (bounded, token-touching).
    const enableRes = await livenessEnablePending(pool, { limit: enableLimit, log: (m) => log(`enable: ${m}`) });
    summary.enabled = enableRes.enabled.length;

    // 6. RESEARCH new canonicals → wiki summaries (bounded, token-touching).
    const researchRes = await researchMissingCanonicals(pool, { limit: researchLimit, log: (m) => log(`research: ${m}`) });
    summary.researched = researchRes.researched.length;

    summary.finishedAt = new Date().toISOString();
    // Persist last-run + summary so the scheduler can pace itself + the status
    // endpoint can report it.
    await run(pool, `INSERT INTO settings (key, value) VALUES ('catalog_sync_last_run', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [summary.finishedAt]);
    await run(pool, `INSERT INTO settings (key, value) VALUES ('catalog_sync_last_summary', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(summary)]);
    log(`done: +${summary.added} added, ${summary.retired} retired, ${summary.enabled} enabled, ${summary.researched} researched`);
    return summary;
  } catch (err: any) {
    summary.note = `error: ${err?.message ?? err}`;
    summary.finishedAt = new Date().toISOString();
    log(summary.note);
    return summary;
  } finally {
    running = false;
  }
}

export async function getLastSyncStatus(pool: pg.Pool): Promise<{ lastRun: string | null; summary: CatalogSyncSummary | null }> {
  const runRow = await get<{ value: string }>(pool, `SELECT value FROM settings WHERE key = 'catalog_sync_last_run'`);
  const sumRow = await get<{ value: string }>(pool, `SELECT value FROM settings WHERE key = 'catalog_sync_last_summary'`);
  let summary: CatalogSyncSummary | null = null;
  if (sumRow?.value) { try { summary = JSON.parse(sumRow.value); } catch { summary = null; } }
  return { lastRun: runRow?.value ?? null, summary };
}
