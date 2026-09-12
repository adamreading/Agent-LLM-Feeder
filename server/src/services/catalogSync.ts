import type pg from 'pg';
import { all, get, run } from '../db/pgCompat.js';
import { discoverLiveModels, isTrustworthyPoll, type DiscoveryResult } from './catalogDiscovery.js';
import { classifyModelKind } from './modelKind.js';
import { matchModels, createCanonicalFromModel } from './modelCanon.js';
import { livenessEnablePending } from './livenessEnable.js';
import { researchMissingCanonicals } from './modelResearch.js';
import { parseParamsB } from './paramsBackfill.js';

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
//   2c. ENABLE-ON-DISCOVERY (2026-09-06, default ON) — remaining pending free chat
//      models on a keyed platform go live with NO probe; failures bench them on
//      first real use (proxy hot path + modelHealth). FEEDER_ENABLE_WITHOUT_PROBE=0
//      restores probe-first.
//   5. ENABLE    — bounded liveness pass flips working new models to enabled=true
//      (only enabled instances show in the wiki / route). Capped per run. With 2c
//      on, this only sees leftovers (platforms without a key) → ~zero token spend.
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
  reclassifiedPaid: number;    // pending models re-sorted to paid_tier from FREE catalog pricing (no token)
  reclassifiedNonChat: number; // pending models re-sorted to non-chat from FREE catalog modality (no token)
  note?: string;
}

// Reasons owned by OTHER auto-disable mechanisms — never overridden by retirement
// (schema.ts disabled_reason ownership rule). We only retire rows that are live
// (enabled) or in our own pending/delisted states.
const RETIRE_ELIGIBLE = `(enabled = true OR disabled_reason LIKE 'pending-liveness%' OR disabled_reason = 'delisted')`;

// Gateways whose /models mixes paid + free ids WITHOUT pricing metadata 2b can read.
// Only ids matching the pattern may be enabled-on-discovery or liveness-probed;
// the rest are paid_tier at discovery. (openrouter/kilo are NOT here — 2b prices
// them from real metadata; a pattern would mis-file `openrouter/free`-style routers.)
const MIXED_GATEWAY_FREE_ID: Partial<Record<string, string>> = {
  opencode: '-free$',   // deepseek-v4-flash-free, nemotron-3-ultra-free, …
  // (vercel removed 2026-09-06 — the provider was dropped for card-on-file PAYG risk)
};
// Platforms where the free set can only be learned by a REAL inference probe, never
// from /models: no enable-on-discovery, and stage-5 liveness (402 "insufficient
// balance" → paid_tier, 200 → enabled) is the only truth. GMI is here because its
// /models pricing LIES (measured 2026-09-06): it lists a model TWICE at two different
// prices (83 rows / 81 unique ids) and the displayed price for MiniMax-M3 flipped
// $0 → priced within 3 min, yet the model served 200 on 4/4 real calls. So pricing
// can't classify it — only the probe can.
const ENABLE_PROBE_FIRST = new Set<string>(['gmi', 'hetzner']);
// hetzner (added 2026-09-06): the token is valid and GET /models 200s, but the free
// EXPERIMENT frequently 503s "ServiceUnavailable — failed to find endpoint candidates"
// (no serving capacity). Probe-first means the liveness probe leaves a 503 model
// PENDING (503 → transient in livenessEnable, not enabled, not benched) and enables it
// only once it actually serves 200 — so feeder never routes at a dead experiment, and
// picks the 2 Qwen models up automatically the moment Hetzner has capacity.
// …and for the SAME reason, 2b's pricing-based paid-marking must be skipped for these
// platforms, or it marks the genuinely-free models paid before the probe ever runs.
const PRICING_UNRELIABLE = new Set<string>(['gmi']);

// Specialist (non-chat) modalities feeder can actually SERVE, mapped to the
// platforms with a working adapter (a provider method — see providers/*.ts).
// A free model of such a kind on such a platform is enabled and routable via
// that modality's endpoint ONLY (never chat). image_gen on cloudflare is first
// (2026-09-12). Add a platform here only once its adapter is implemented.
const SPECIALIST_ADAPTERS: Record<string, string[]> = { image_gen: ['cloudflare'] };

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
    reclassifiedPaid: 0, reclassifiedNonChat: 0,
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
        // params_b from the size token in the id when present (zero-token, deterministic);
        // the weekly leaderboard run's HF sweep fills the tokenless ones. Feeds sizeFactor
        // + the big100 band so a newly-listed large model is correctly sized same-day.
        const paramsB = parseParamsB(modelId, name);
        const row = await get<{ id: number }>(pool, `
          INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, cost_tier, disabled_reason, match_status, kind, params_b, last_seen_live, missing_polls)
          VALUES (?, ?, ?, 500, 500, false, 'free', 'pending-liveness (daily-sync)', 'unmatched', ?, ?, now(), 0)
          ON CONFLICT (platform, model_id) DO NOTHING
          RETURNING id
        `, [platform, modelId, name, classifyModelKind(modelId, name), paramsB]);
        if (row?.id) { newlyAddedIds.push(row.id); summary.added++; }
      }

      // 2b. CLASSIFY (free, zero-token). Sort pending models using ONLY the metadata
      //     the free GET /models already returned — no liveness completion. Covers
      //     both this run's new inserts AND the pre-existing pending backlog (any
      //     pending row whose id is in this poll). Two moves, both keyed strictly to
      //     our own 'pending-liveness%' rows so nothing else is touched:
      //       PAID  — a priced model (openrouter/kilo per-token `pricing`, kilo also
      //               `isFree`) → paid_tier, so it never becomes a liveness candidate
      //               (this is the bulk of the backlog: ~660 of ~900 are paid).
      //       NON-CHAT — a non-text-output model (`output_modalities`) → dropped from
      //               pending as a backstop for anything the id-heuristic missed.
      //     A null (unknown) metadatum changes nothing — a metadata-poor provider's
      //     rows stay exactly as pending-liveness, same as before this stage existed.
      const meta = d.models ?? [];
      // Skip pricing-based paid-marking where the provider's /models pricing is
      // untrustworthy (see PRICING_UNRELIABLE) — the liveness probe classifies instead.
      const paidIds = PRICING_UNRELIABLE.has(platform) ? [] : meta.filter((x) => x.paid === true).map((x) => x.id);
      const nonTextIds = meta.filter((x) => x.outputText === false).map((x) => x.id);
      if (paidIds.length) {
        // Covers pending rows AND any LIVE free-tier row (enabled, no reason) that a
        // prior sync wrongly enabled — so a model the provider's own catalog prices
        // (incl. the -1 variable-price routers) can't stay routable as free. A
        // manual/no_key/unhealthy row is never touched (its disabled_reason ≠ NULL).
        const rp = await run(pool, `
          UPDATE models SET enabled = false, disabled_reason = 'paid_tier', cost_tier = 'paid'
          WHERE platform = ? AND model_id = ANY(?::text[])
            AND (disabled_reason LIKE 'pending-liveness%' OR (enabled = true AND disabled_reason IS NULL))
        `, [platform, paidIds]);
        summary.reclassifiedPaid += rp.changes;
      }
      if (nonTextIds.length) {
        const rn = await run(pool, `
          UPDATE models SET disabled_reason = 'non-chat (catalog: non-text output)'
          WHERE platform = ? AND disabled_reason LIKE 'pending-liveness%' AND model_id = ANY(?::text[])
        `, [platform, nonTextIds]);
        summary.reclassifiedNonChat += rn.changes;
      }

      // 2c. ENABLE-ON-DISCOVERY (Adam, 2026-09-06: "pass all free models into
      //     live use and fail them on failure — not require a live probe wasting
      //     tokens"). After 2b has sorted out paid/non-chat, every remaining
      //     pending free CHAT model on a platform we hold a usable key for goes
      //     straight to enabled=true. No completion is spent. Demotion is then
      //     observe-on-use: the proxy hot path benches 402→paid_tier, 403/404/
      //     410→unreachable on the FIRST real failure, and modelHealth's 30-min +
      //     7-day low-success passes catch the rest. Cost of a dead model = one
      //     failed attempt (then fallback), once. Set FEEDER_ENABLE_WITHOUT_PROBE=0
      //     to restore the old probe-first path (stage 5 still runs on leftovers).
      //     ⛔ MIXED-CATALOG GATEWAYS (added 2026-09-06 after 2c enabled 60 PAID opencode
      //     models — claude-opus-5 etc. — because opencode exposes no pricing metadata
      //     for 2b): where a gateway lists paid + free ids together and 2b can't price
      //     them, the FREE ids follow a suffix convention. Anything NOT matching is
      //     marked paid_tier HERE, so it is neither enabled by 2c nor probed by stage 5
      //     (on Vercel a card is on file — even a liveness probe of a paid id would
      //     charge). Platforms absent from this map are all-free-tier (or 2b-priced).
      const freePat = MIXED_GATEWAY_FREE_ID[platform];
      if (freePat) {
        // Covers pending rows AND any LIVE row (enabled, no reason) that slipped
        // through before this gate existed — the sync self-heals the catalog, so a
        // paid id can't stay routable on a funded gateway account.
        const rp2 = await run(pool, `
          UPDATE models SET enabled = false, disabled_reason = 'paid_tier', cost_tier = 'paid'
          WHERE platform = ? AND kind = 'chat' AND NOT (model_id ~* ?)
            AND (disabled_reason LIKE 'pending-liveness%' OR (enabled = true AND disabled_reason IS NULL))
        `, [platform, freePat]);
        if (rp2.changes > 0) log(`${platform}: ${rp2.changes} non-free id(s) → paid_tier (mixed-gateway gate)`);
        summary.reclassifiedPaid += rp2.changes;
      }
      if (process.env.FEEDER_ENABLE_WITHOUT_PROBE !== '0' && !ENABLE_PROBE_FIRST.has(platform)) {
        const eod = await run(pool, `
          UPDATE models SET enabled = true, disabled_reason = NULL
          WHERE platform = ? AND kind = 'chat' AND disabled_reason LIKE 'pending-liveness%'
            AND EXISTS (SELECT 1 FROM api_keys k WHERE k.platform = models.platform AND k.enabled = true AND k.status != 'invalid')
        `, [platform]);
        if (eod.changes > 0) { summary.enabled += eod.changes; log(`${platform}: enabled-on-discovery ${eod.changes} free chat model(s), no probe`); }
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
      //     Rows ALREADY delisted are excluded so `retired` counts NEW retirements —
      //     it used to re-stamp every delisted row and report "156 retired" on every
      //     run (2026-09-11), which read like a mass loss of models when nothing
      //     routable had changed. (3c still bumps their miss counter; RETIRE_ELIGIBLE
      //     keeps 'delisted' so a reappearance can un-retire them.)
      const retired = await run(pool, `
        UPDATE models SET enabled = false, disabled_reason = 'delisted'
        WHERE platform = ? AND last_seen_live IS NOT NULL
          AND NOT (model_id = ANY(?::text[])) AND missing_polls >= ? AND ${RETIRE_ELIGIBLE}
          AND disabled_reason IS DISTINCT FROM 'delisted'
      `, [platform, liveIds, retireThreshold]);
      summary.retired += retired.changes;
    }

    log(`discovery: +${summary.added} new, ${summary.reappeared} reappeared, ${summary.retired} retired`);

    // 3e. FALLBACK ROWS (2026-09-11). routeRequest's chain is fallback_config JOIN
    //     models, and fallback_config rows were only ever created at BOOT
    //     (db/index.ts addMissingFallbackEntries, inside the migrations) — so a
    //     model this sync ADDED and 2c ENABLED was invisible to the router until
    //     the next restart (measured 2026-09-11: 2 enabled by the sync, 0 in the
    //     chain). Idempotent: only rows with no fc entry; appended after the
    //     current max priority (ordering is score-driven anyway, see router.ts).
    const fcAdded = await run(pool, `
      INSERT INTO fallback_config (model_db_id, priority, enabled)
      SELECT m.id,
             (SELECT COALESCE(MAX(priority), 0) FROM fallback_config) + ROW_NUMBER() OVER (ORDER BY m.intelligence_rank, m.id),
             true
      FROM models m LEFT JOIN fallback_config f ON f.model_db_id = m.id
      WHERE f.id IS NULL
    `);
    if (fcAdded.changes > 0) log(`fallback rows: +${fcAdded.changes} model(s) now visible to the router`);

    // 3f. KIND RE-CLASSIFY (zero-token, 2026-09-11). classifyModelKind only ever ran
    //     at INSERT, so a heuristic fix never reached existing rows. Google's Lyria
    //     MUSIC models sat as kind='chat' on google + openrouter (with a 0.80
    //     creative_writing score from research) and a Discord room got sticky-
    //     locked to one for 7h — 147 "successful" chat completions from a music
    //     generator (2026-09-10). Re-run the heuristic over every chat row: a flip
    //     to non-chat sets kind (structural exclusion from the chain) and disables
    //     the row. Conservative by construction — the heuristic flips only on clear
    //     non-chat signals — and a row already disabled for another reason keeps it.
    const chatRows = await all<{ id: number; model_id: string; display_name: string | null }>(pool,
      `SELECT id, model_id, display_name FROM models WHERE kind = 'chat'`);
    let kindFlips = 0;
    for (const r of chatRows) {
      const k = classifyModelKind(r.model_id, r.display_name ?? '');
      if (k === 'chat') continue;
      await run(pool, `
        UPDATE models SET kind = ?, enabled = false,
          disabled_reason = CASE WHEN enabled = true OR disabled_reason IS NULL OR disabled_reason LIKE 'pending-liveness%'
                                 THEN ? ELSE disabled_reason END
        WHERE id = ?
      `, [k, `non-chat (id heuristic: ${k})`, r.id]);
      kindFlips++;
      log(`kind: ${r.model_id} → ${k} (was chat)`);
    }
    summary.reclassifiedNonChat += kindFlips;

    // 3g. SPECIALIST ENABLE (after the kind reclassify, so a model just moved to
    //     image_gen is picked up the SAME run). A free specialist model on a
    //     platform with a working adapter becomes enabled + routable in its
    //     modality — reachable ONLY via that modality's endpoint, never chat
    //     (the router filters by kind and requires the provider's modality
    //     method). Skips paid/no-key/manual rows (their reason isn't non-chat/
    //     pending). Needs a fallback_config row (3e created any missing ones).
    for (const [k, plats] of Object.entries(SPECIALIST_ADAPTERS)) {
      const se = await run(pool, `
        UPDATE models SET enabled = true, disabled_reason = NULL
        WHERE kind = ? AND cost_tier = 'free' AND platform = ANY(?::text[])
          AND (disabled_reason IS NULL OR disabled_reason LIKE 'non-chat%' OR disabled_reason LIKE 'pending-liveness%')
          AND EXISTS (SELECT 1 FROM api_keys key WHERE key.platform = models.platform AND key.enabled = true AND key.status != 'invalid')
      `, [k, plats]);
      if (se.changes > 0) { summary.enabled += se.changes; log(`enabled ${se.changes} free ${k} model(s) on ${plats.join('/')} (specialist)`); }
    }

    // 4. MATCH new rows to canonicals; create a wiki entry for each new CHAT
    //    model still unmatched (leaves the existing manual review queue alone —
    //    only touches rows we added this run).
    if (newlyAddedIds.length) {
      await matchModels(pool);
      // Only free chat models still awaiting liveness earn a wiki canonical. Excluding
      // the rows step 2b just re-sorted to paid_tier / non-chat means we never spend
      // stage-6 research (search-credit) on a model we already know is paid or non-chat.
      const unmatchedNew = await all<{ id: number }>(pool, `
        SELECT id FROM models WHERE id = ANY(?::int[]) AND canonical_model_id IS NULL
          AND kind = 'chat' AND disabled_reason LIKE 'pending-liveness%'
      `, [newlyAddedIds]);
      for (const m of unmatchedNew) {
        try { await createCanonicalFromModel(pool, m.id); summary.canonicalsCreated++; }
        catch (err: any) { log(`canonical create failed for model ${m.id}: ${err?.message ?? err}`); }
      }
      log(`matched new rows; created ${summary.canonicalsCreated} canonical wiki entries`);
    }

    // 5. ENABLE working new models (bounded, token-touching).
    const enableRes = await livenessEnablePending(pool, { limit: enableLimit, log: (m) => log(`enable: ${m}`) });
    summary.enabled += enableRes.enabled.length; // += : stage 2c already counted enable-on-discovery

    // 6. RESEARCH new canonicals → wiki summaries (bounded, token-touching).
    const researchRes = await researchMissingCanonicals(pool, { limit: researchLimit, log: (m) => log(`research: ${m}`) });
    summary.researched = researchRes.researched.length;

    summary.finishedAt = new Date().toISOString();
    log(`done: +${summary.added} added, ${summary.reclassifiedPaid} →paid, ${summary.reclassifiedNonChat} →non-chat, ${summary.retired} retired, ${summary.enabled} enabled, ${summary.researched} researched`);
    return summary;
  } catch (err: any) {
    summary.note = `error: ${err?.message ?? err}`;
    summary.finishedAt = new Date().toISOString();
    log(summary.note);
    return summary;
  } finally {
    running = false;
    // Persist last-run + summary on BOTH paths (success AND failure). Was previously
    // stamped only on the success path, so a THROWING sync left catalog_sync_last_run
    // stale → the hourly scheduler tick re-ran the FULL sync every hour instead of
    // daily (24×, and the token/credit-touching stages re-spent), and the status
    // endpoint reported the last SUCCESS, hiding the failure. Key the pace + status on
    // a marker the work CANNOT withhold. finishedAt is set on both the try and catch
    // paths above, so it is always populated here. Local-pg write (feeder's own DB, up
    // even when a provider call is what failed); guarded so a rare local hiccup can't
    // throw out of the finally and re-introduce the stale-timestamp bug.
    try {
      await run(pool, `INSERT INTO settings (key, value) VALUES ('catalog_sync_last_run', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [summary.finishedAt]);
      await run(pool, `INSERT INTO settings (key, value) VALUES ('catalog_sync_last_summary', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(summary)]);
    } catch (persistErr: any) {
      log(`WARN: failed to persist catalog_sync_last_run/summary: ${persistErr?.message ?? persistErr}`);
    }
  }
}

export async function getLastSyncStatus(pool: pg.Pool): Promise<{ lastRun: string | null; summary: CatalogSyncSummary | null }> {
  const runRow = await get<{ value: string }>(pool, `SELECT value FROM settings WHERE key = 'catalog_sync_last_run'`);
  const sumRow = await get<{ value: string }>(pool, `SELECT value FROM settings WHERE key = 'catalog_sync_last_summary'`);
  let summary: CatalogSyncSummary | null = null;
  if (sumRow?.value) { try { summary = JSON.parse(sumRow.value); } catch { summary = null; } }
  return { lastRun: runRow?.value ?? null, summary };
}
