// Import the curated wiki seed (server/seed/wiki-seed.json) onto ANY database,
// idempotently, keyed on natural keys (canonical slug, platform+model_id) so it
// works on a fresh install where serial ids differ. Layers the curated
// summaries / capabilities / task-scores / rate-limits / context on top of
// whatever the migrations created. Safe to re-run. Does NOT touch api_keys or
// live latency/quota. Usage: npm run seed:wiki:import  (or npx tsx ...)
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, get, run, runReturningId } from '../db/pgCompat.js';
import { readFileSync } from 'node:fs';

const SEED_PATH = new URL('../../seed/wiki-seed.json', import.meta.url).pathname;

async function main() {
  await initDb();
  const pool = getPool();
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  let canonUpserts = 0, modelUpserts = 0, capUpserts = 0, scoreUpserts = 0;

  // 1) canonical_models by slug
  const slugToId = new Map<string, number>();
  for (const c of seed.canonical_models) {
    const existing = await get<{ id: number }>(pool, `SELECT id FROM canonical_models WHERE slug = ?`, [c.slug]);
    let id: number;
    if (existing) {
      id = existing.id;
      await run(pool, `UPDATE canonical_models SET name=?, summary=COALESCE(?,summary), vision=?, video=?, audio=?, updated_at=now() WHERE id=?`,
        [c.name, c.summary ?? null, c.vision, c.video, c.audio, id]);
    } else {
      id = await runReturningId(pool, `INSERT INTO canonical_models (name, slug, summary, vision, video, audio) VALUES (?,?,?,?,?,?)`,
        [c.name, c.slug, c.summary ?? null, c.vision, c.video, c.audio]);
    }
    slugToId.set(c.slug, id);
    canonUpserts++;

    for (const key of c.aliases ?? []) {
      await run(pool, `INSERT INTO canonical_model_aliases (canonical_model_id, alias_key) VALUES (?,?) ON CONFLICT (alias_key) DO UPDATE SET canonical_model_id=EXCLUDED.canonical_model_id`, [id, key]);
    }
    // task_scores: replace this canonical's set with the seed's
    await run(pool, `DELETE FROM task_scores WHERE canonical_model_id=?`, [id]);
    for (const s of c.task_scores ?? []) {
      await run(pool, `INSERT INTO task_scores (canonical_model_id, task_type, score, rank, source) VALUES (?,?,?,?,?)`, [id, s.task_type, s.score, s.rank ?? null, s.source ?? 'benchmark']);
      scoreUpserts++;
    }
  }

  // 2) models by (platform, model_id)
  for (const m of seed.models) {
    const canonicalId = m.canonical_slug ? slugToId.get(m.canonical_slug) ?? null : null;
    const existing = await get<{ id: number }>(pool, `SELECT id FROM models WHERE platform=? AND model_id=?`, [m.platform, m.model_id]);
    let id: number;
    if (existing) {
      id = existing.id;
      await run(pool, `UPDATE models SET display_name=?, size_label=?, cost_tier=?, context_window=?,
        intelligence_rank=?, speed_rank=?, rpm_limit=?, rpd_limit=?, tpm_limit=?, tpd_limit=?,
        monthly_token_budget=?, enabled=?, disabled_reason=?, canonical_model_id=COALESCE(?,canonical_model_id)
        WHERE id=?`,
        [m.display_name, m.size_label, m.cost_tier, m.context_window, m.intelligence_rank, m.speed_rank,
         m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.monthly_token_budget, m.enabled, m.disabled_reason, canonicalId, id]);
    } else {
      id = await runReturningId(pool, `INSERT INTO models
        (platform, model_id, display_name, size_label, cost_tier, context_window, intelligence_rank, speed_rank,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, enabled, disabled_reason, canonical_model_id, match_status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [m.platform, m.model_id, m.display_name, m.size_label, m.cost_tier, m.context_window, m.intelligence_rank, m.speed_rank,
         m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.monthly_token_budget, m.enabled, m.disabled_reason, canonicalId,
         canonicalId ? 'auto_matched' : 'unmatched']);
    }
    modelUpserts++;
    // capabilities: upsert per (model, capability, source)
    for (const cap of m.capabilities ?? []) {
      await run(pool, `INSERT INTO model_capabilities (model_db_id, capability, supported, dialect, score, source, evidence, measured_at)
        VALUES (?,?,?,?,?,?,?, now())
        ON CONFLICT (model_db_id, capability, source) DO UPDATE SET supported=EXCLUDED.supported, dialect=EXCLUDED.dialect, score=EXCLUDED.score, evidence=EXCLUDED.evidence, measured_at=now()`,
        [id, cap.capability, cap.supported, cap.dialect ?? null, cap.score ?? null, cap.source ?? 'declared', cap.evidence ?? null]);
      capUpserts++;
    }
  }

  console.log(`Imported: canonicals=${canonUpserts} models=${modelUpserts} capabilities=${capUpserts} task_scores=${scoreUpserts}`);
  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });
