// Export the curated wiki dataset to a git-committable JSON seed
// (server/seed/wiki-seed.json). Keyed on NATURAL keys (canonical slug,
// platform+model_id) — never serial ids — so it imports cleanly onto a fresh
// DB. Excludes secrets (api_keys) and live/runtime state (model_health
// latency, quota_snapshots) which regenerate at runtime. Pairs with
// import-wiki-seed.ts. Usage: npx tsx src/scripts/export-wiki-seed.ts
//
// CURATED, not a raw dump: ships ALL canonical_models (the researched
// knowledge base — summaries, modality, task-scores, aliases) but only the
// REAL model instances (enabled, plus paid-only/paid_tier/manual rows that are
// genuine models simply not free on this box). The my-box noise — never-verified
// `pending-liveness` rows, `dead:`/`delisted`/`no_key`/`unavailable`/`unreachable`
// — is dropped; a fresh install's own key-driven catalog discovery + liveness
// repopulates live instances. See MODEL_KEEP_WHERE below.
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all } from '../db/pgCompat.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SEED_PATH = new URL('../../seed/wiki-seed.json', import.meta.url).pathname;

async function main() {
  await initDb();
  const pool = getPool();

  // Keep enabled instances + genuine-but-not-free rows (paid-only/paid_tier/manual);
  // drop unverified/dead noise (pending-liveness, dead:, delisted, no_key, unavailable,
  // unreachable, duplicate, non-chat, ...). Canonical knowledge is ALWAYS shipped whole.
  const MODEL_KEEP_WHERE = `(enabled = true OR disabled_reason ILIKE 'paid%' OR disabled_reason = 'manual')`;

  const canonicals = await all<any>(pool, `SELECT id, name, slug, summary, vision, video, audio FROM canonical_models ORDER BY slug`);
  const aliases = await all<{ canonical_model_id: number; alias_key: string }>(pool, `SELECT canonical_model_id, alias_key FROM canonical_model_aliases`);
  const scores = await all<any>(pool, `SELECT canonical_model_id, task_type, score, rank, source FROM task_scores`);
  const models = await all<any>(pool, `
    SELECT id, platform, model_id, display_name, size_label, cost_tier, context_window,
           intelligence_rank, speed_rank, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
           monthly_token_budget, enabled, disabled_reason, canonical_model_id
    FROM models WHERE ${MODEL_KEEP_WHERE} ORDER BY platform, model_id`);
  const caps = await all<any>(pool, `SELECT model_db_id, capability, supported, dialect, score, source, evidence FROM model_capabilities`);

  const canonById = new Map(canonicals.map((c) => [c.id, c]));
  const modelById = new Map(models.map((m) => [m.id, m]));

  const capsByModel = new Map<number, any[]>();
  for (const c of caps) { (capsByModel.get(c.model_db_id) ?? capsByModel.set(c.model_db_id, []).get(c.model_db_id)!).push({ capability: c.capability, supported: c.supported, dialect: c.dialect, score: c.score, source: c.source, evidence: c.evidence }); }
  const aliasByCanon = new Map<number, string[]>();
  for (const a of aliases) { (aliasByCanon.get(a.canonical_model_id) ?? aliasByCanon.set(a.canonical_model_id, []).get(a.canonical_model_id)!).push(a.alias_key); }
  const scoresByCanon = new Map<number, any[]>();
  for (const s of scores) { (scoresByCanon.get(s.canonical_model_id) ?? scoresByCanon.set(s.canonical_model_id, []).get(s.canonical_model_id)!).push({ task_type: s.task_type, score: s.score, rank: s.rank, source: s.source }); }

  const seedCanonicals = canonicals.map((c) => ({
    slug: c.slug, name: c.name, summary: c.summary, vision: c.vision, video: c.video, audio: c.audio,
    aliases: aliasByCanon.get(c.id) ?? [],
    task_scores: scoresByCanon.get(c.id) ?? [],
  }));
  const seedModels = models.map((m) => ({
    platform: m.platform, model_id: m.model_id, display_name: m.display_name, size_label: m.size_label,
    cost_tier: m.cost_tier, context_window: m.context_window, intelligence_rank: m.intelligence_rank,
    speed_rank: m.speed_rank, rpm_limit: m.rpm_limit, rpd_limit: m.rpd_limit, tpm_limit: m.tpm_limit,
    tpd_limit: m.tpd_limit, monthly_token_budget: m.monthly_token_budget, enabled: m.enabled,
    disabled_reason: m.disabled_reason,
    canonical_slug: m.canonical_model_id ? canonById.get(m.canonical_model_id)?.slug ?? null : null,
    capabilities: capsByModel.get(m.id) ?? [],
  }));

  const seed = {
    _note: 'Curated LLM-Feeder wiki seed (starter knowledge base). Import with `npm run seed:wiki:import` (idempotent, natural-key keyed). Ships ALL researched canonical entries + only REAL model instances (enabled/paid/manual) — my-box pending-liveness/dead/delisted noise is dropped; your own keys + catalog discovery repopulate live instances. Excludes secrets and live latency/quota. Regenerate with `npm run seed:wiki:export`.',
    schema_version: 1,
    canonical_models: seedCanonicals,
    models: seedModels,
  };

  mkdirSync(dirname(SEED_PATH), { recursive: true });
  writeFileSync(SEED_PATH, JSON.stringify(seed, null, 2));
  console.log(`Wrote ${SEED_PATH}`);
  console.log(`  canonical_models: ${seedCanonicals.length}`);
  console.log(`  models:           ${seedModels.length}`);
  console.log(`  capability rows:  ${caps.length}`);
  console.log(`  task_score rows:  ${scores.length}`);
  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });
