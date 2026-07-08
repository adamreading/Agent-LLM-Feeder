import type pg from 'pg';
import { all, get, run, runReturningId } from '../db/pgCompat.js';

// Adam's directive (2026-07-08): the model wiki must group by real underlying
// model, not by (platform, model_id) row — the same weights routinely show
// up under different id spellings per supplier (gpt-oss-120b on cerebras vs
// openai/gpt-oss-120b:free on openrouter vs @cf/openai/gpt-oss-120b on
// cloudflare). This module resolves that grouping.
//
// normalize() reduces a model_id to a comparison key: strip vendor-path
// wrappers, take the last '/'-segment (drops org/vendor prefixes), drop a
// trailing ':free' tag, then collapse every non-alphanumeric character.
// Dry-run verified against the live 90-row catalog (2026-07-08): produced 11
// multi-member groups, all genuine cross-platform duplicates on manual
// inspection (e.g. correctly linked zhipu/glm-4.7-flash with cloudflare's
// @cf/zai-org/glm-4.7-flash despite unrelated platform paths), zero false
// merges. Deliberately exact-match only, not fuzzy — a wrong auto-merge
// would misattribute measured capability facts between two different
// models, exactly the kind of silent error this whole system exists to
// prevent. Anything that doesn't collide exactly stays unmatched for the
// human review queue rather than risk a bad guess.
export function normalizeModelId(modelId: string): string {
  let s = modelId.toLowerCase();
  s = s.replace(/^@[a-z0-9_-]+\//, ''); // strip a leading @vendor/ wrapper (cloudflare style)
  const parts = s.split('/');
  s = parts[parts.length - 1]; // drop any remaining org/vendor path prefix, keep the leaf
  s = s.replace(/:free$/, '');
  s = s.replace(/-(latest|preview)$/, '');
  s = s.replace(/[^a-z0-9]/g, ''); // collapse separators (-, ., _, :, spaces) for tolerant comparison
  return s;
}

function titleCaseFromModelId(modelId: string): string {
  const leaf = modelId.split('/').pop() ?? modelId;
  return leaf
    .replace(/^@[a-z0-9_-]+\//, '')
    .replace(/[-_]/g, ' ')
    .replace(/:free$/i, '')
    .trim();
}

async function slugify(pool: pg.Pool, base: string): Promise<string> {
  const baseSlug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'model';
  let slug = baseSlug;
  let n = 2;
  while (await get(pool, 'SELECT id FROM canonical_models WHERE slug = ?', [slug])) {
    slug = `${baseSlug}-${n++}`;
  }
  return slug;
}

interface UnmatchedRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
}

// Idempotent — safe to call on every startup and on demand. Two passes:
//   1. Alias lookup: any unmatched row whose normalized key already has a
//      canonical alias links to it immediately (covers a new supplier
//      instance of an already-canonicalized model — the common ongoing case).
//   2. Bootstrap grouping: among rows STILL unmatched after pass 1, group by
//      normalized key. Every group becomes a canonical model — a 2+-member
//      group is a same-model duplicate merged into one entry; a singleton
//      becomes its own 1:1 canonical — so the wiki reflects the whole catalog,
//      not just cross-platform duplicates. The review UI stays for correcting
//      a bad auto-merge or re-linking a mis-grouped instance.
export async function matchModels(pool: pg.Pool): Promise<{ autoLinkedToExisting: number; autoMergedGroups: number; autoMergedRows: number; stillUnmatched: number }> {
  const unmatched = await all<UnmatchedRow>(pool, `
    SELECT id, platform, model_id, display_name FROM models WHERE canonical_model_id IS NULL
  `);

  let autoLinkedToExisting = 0;
  const stillUnmatchedAfterPass1: UnmatchedRow[] = [];

  for (const row of unmatched) {
    const key = normalizeModelId(row.model_id);
    const alias = await get<{ canonical_model_id: number }>(pool,
      'SELECT canonical_model_id FROM canonical_model_aliases WHERE alias_key = ?', [key]
    );
    if (alias) {
      await run(pool, `UPDATE models SET canonical_model_id = ?, match_status = 'auto_matched' WHERE id = ?`, [alias.canonical_model_id, row.id]);
      autoLinkedToExisting++;
    } else {
      stillUnmatchedAfterPass1.push(row);
    }
  }

  const groups = new Map<string, UnmatchedRow[]>();
  for (const row of stillUnmatchedAfterPass1) {
    const key = normalizeModelId(row.model_id);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  let autoMergedGroups = 0;
  let autoMergedRows = 0;
  for (const [key, members] of groups) {
    // Every distinct model gets a canonical entry — a cross-platform group is
    // merged into one, and a singleton becomes its own 1:1 canonical — so the
    // wiki surfaces the whole catalog rather than only the models that happen
    // to be offered by more than one supplier. (Earlier this skipped
    // singletons pending manual review, which left most of the catalog
    // invisible.) Genuine cross-platform collisions still merge; the review UI
    // remains for correcting a bad auto-merge or re-linking.
    // Prefer the shortest display_name as the canonical label — the id
    // spelling with the least platform-specific decoration (fewest instances
    // of "(SambaNova)"/"(free)"/"(CF)" style suffixes seen in the catalog).
    const best = members.reduce((a, b) => (a.display_name.length <= b.display_name.length ? a : b));
    const name = titleCaseFromModelId(best.model_id) || best.display_name;
    const slug = await slugify(pool, name);
    const canonicalId = await runReturningId(pool, `
      INSERT INTO canonical_models (name, slug) VALUES (?, ?)
    `, [name, slug]);
    await run(pool, `INSERT INTO canonical_model_aliases (canonical_model_id, alias_key) VALUES (?, ?)`, [canonicalId, key]);
    for (const member of members) {
      await run(pool, `UPDATE models SET canonical_model_id = ?, match_status = 'auto_matched' WHERE id = ?`, [canonicalId, member.id]);
    }
    autoMergedGroups++;
    autoMergedRows += members.length;
  }

  const stillUnmatched = await get<{ cnt: string }>(pool, `SELECT COUNT(*) as cnt FROM models WHERE canonical_model_id IS NULL`);

  return { autoLinkedToExisting, autoMergedGroups, autoMergedRows, stillUnmatched: Number(stillUnmatched?.cnt ?? 0) };
}

// Manual resolution path for the review UI: link an unmatched row to an
// EXISTING canonical model, and teach the alias table this row's normalized
// key so future same-model instances (new suppliers, catalog refreshes)
// auto-link on the next matchModels() pass without repeating the manual step.
export async function linkToExistingCanonical(pool: pg.Pool, modelDbId: number, canonicalModelId: number): Promise<void> {
  const model = await get<{ model_id: string }>(pool, 'SELECT model_id FROM models WHERE id = ?', [modelDbId]);
  if (!model) throw new Error(`No models row with id ${modelDbId}`);
  const canonical = await get<{ id: number }>(pool, 'SELECT id FROM canonical_models WHERE id = ?', [canonicalModelId]);
  if (!canonical) throw new Error(`No canonical_models row with id ${canonicalModelId}`);

  const key = normalizeModelId(model.model_id);
  // Upsert: this row may already carry an alias (every model is auto-
  // canonicalized now), so re-point it to the chosen canonical rather than
  // colliding on the UNIQUE(alias_key) constraint.
  await run(pool, `
    INSERT INTO canonical_model_aliases (canonical_model_id, alias_key) VALUES (?, ?)
    ON CONFLICT (alias_key) DO UPDATE SET canonical_model_id = EXCLUDED.canonical_model_id
  `, [canonicalModelId, key]);
  await run(pool, `UPDATE models SET canonical_model_id = ?, match_status = 'manual_matched' WHERE id = ?`, [canonicalModelId, modelDbId]);
}

// "New" path for the review UI: this row isn't a match for anything that
// exists yet — create a fresh canonical entry from it.
export async function createCanonicalFromModel(
  pool: pg.Pool,
  modelDbId: number,
  fields: { name?: string; summary?: string; vision?: boolean; video?: boolean; audio?: boolean } = {}
): Promise<number> {
  const model = await get<{ model_id: string; display_name: string }>(pool, 'SELECT model_id, display_name FROM models WHERE id = ?', [modelDbId]);
  if (!model) throw new Error(`No models row with id ${modelDbId}`);

  const name = fields.name ?? titleCaseFromModelId(model.model_id) ?? model.display_name;
  const slug = await slugify(pool, name);
  const canonicalId = await runReturningId(pool, `
    INSERT INTO canonical_models (name, slug, summary, vision, video, audio)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [name, slug, fields.summary ?? null, fields.vision ?? false, fields.video ?? false, fields.audio ?? false]);

  const key = normalizeModelId(model.model_id);
  await run(pool, `
    INSERT INTO canonical_model_aliases (canonical_model_id, alias_key) VALUES (?, ?)
    ON CONFLICT (alias_key) DO UPDATE SET canonical_model_id = EXCLUDED.canonical_model_id
  `, [canonicalId, key])
  await run(pool, `UPDATE models SET canonical_model_id = ?, match_status = 'confirmed_new' WHERE id = ?`, [canonicalId, modelDbId]);

  return canonicalId;
}
