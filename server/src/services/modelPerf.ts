import type pg from 'pg';
import { get, run } from '../db/pgCompat.js';
import { taskTypeFor } from './router.js';

// Real-usage quality ingestion (Adam's "dynamic evolving system", 2026-07-10):
// the answer-evaluation capture (wsl's Hermes emitter + windows' OB-write
// signal) reports how good a model's REAL answers were, and that folds into
// the SAME task_scores table that drives both the wiki rating and routing's
// taskQuality — so real usage continuously reshapes which model gets picked.
//
// Stored as source='realtime_quality' (a third source beside the external
// 'benchmark' arena prior and probe 'measured'). One row per (canonical model,
// task_type) holding an EXPONENTIALLY-WEIGHTED MOVING AVERAGE — recent samples
// matter more, no unbounded history, and it needs no count column. The router
// blends this over the benchmark prior (see blendTaskScores in router.ts).

// EWMA weight for a new sample. Deliberately modest so a single noisy judgment
// doesn't swing a model's stored quality — it takes several consistent samples
// to move it meaningfully, which is the right behaviour for a soft score that
// steers production routing.
const SAMPLE_ALPHA = 0.25;

export interface RealtimeQualitySample {
  /** platform/model_id, a bare model_id, or a canonical slug — however the caller knows the served model */
  modelRef: string;
  /** caller task_class (e.g. agentic_chat, coding) — mapped to the arena task_type, same as routing */
  taskClass?: string | null;
  /** 0..1 quality judgement of the model's real answer */
  qualityScore: number;
  /** what produced the score (judge model name, 'ob_write_edited', 'thumbs', …) — recorded as evidence, never fabricated */
  judge?: string | null;
}

// Resolve however the caller named the served model to a canonical_model_id.
// Order: explicit platform/model_id → bare model_id (any instance) →
// canonical slug. Returns null if nothing matches (caller gets a 404 rather
// than silently recording against the wrong model).
async function resolveCanonicalId(pool: pg.Pool, modelRef: string): Promise<number | null> {
  const ref = modelRef.trim();
  const slashIdx = ref.indexOf('/');
  if (slashIdx > 0) {
    const platform = ref.slice(0, slashIdx);
    const modelId = ref.slice(slashIdx + 1);
    const row = await get<{ canonical_model_id: number | null }>(pool,
      `SELECT canonical_model_id FROM models WHERE platform = ? AND model_id = ?`, [platform, modelId]);
    if (row?.canonical_model_id != null) return row.canonical_model_id;
  }
  // Bare model_id — any instance (quality is a property of the weights, shared
  // across suppliers, so any instance's canonical link is correct).
  const bare = await get<{ canonical_model_id: number | null }>(pool,
    `SELECT canonical_model_id FROM models WHERE model_id = ? AND canonical_model_id IS NOT NULL LIMIT 1`, [ref]);
  if (bare?.canonical_model_id != null) return bare.canonical_model_id;
  // Canonical slug.
  const canon = await get<{ id: number }>(pool, `SELECT id FROM canonical_models WHERE slug = ?`, [ref]);
  return canon?.id ?? null;
}

export interface IngestResult { ok: boolean; canonicalId?: number; taskType?: string; newScore?: number; reason?: string }

export async function recordRealtimeQuality(pool: pg.Pool, sample: RealtimeQualitySample): Promise<IngestResult> {
  const q = Number(sample.qualityScore);
  if (!Number.isFinite(q) || q < 0 || q > 1) return { ok: false, reason: 'qualityScore must be a number in [0,1]' };

  const canonicalId = await resolveCanonicalId(pool, sample.modelRef);
  if (canonicalId == null) return { ok: false, reason: `no canonical model resolved for '${sample.modelRef}'` };

  const taskType = taskTypeFor(sample.taskClass);
  const evidence = `realtime_quality${sample.judge ? ` via ${sample.judge}` : ''}`;

  // EWMA upsert: first sample seeds the score; later samples decay toward the
  // new value at SAMPLE_ALPHA. Uses the qualified column name in the DO UPDATE
  // so the existing stored value is the EWMA anchor.
  await run(pool, `
    INSERT INTO task_scores (canonical_model_id, task_type, score, source, evidence, measured_at)
    VALUES (?, ?, ?, 'realtime_quality', ?, now())
    ON CONFLICT (canonical_model_id, task_type, source)
    DO UPDATE SET score = task_scores.score * (1 - ?::real) + EXCLUDED.score * ?::real,
                  evidence = EXCLUDED.evidence, measured_at = now()
  `, [canonicalId, taskType, q, evidence, SAMPLE_ALPHA, SAMPLE_ALPHA]);

  const row = await get<{ score: number }>(pool,
    `SELECT score FROM task_scores WHERE canonical_model_id = ? AND task_type = ? AND source = 'realtime_quality'`,
    [canonicalId, taskType]);
  return { ok: true, canonicalId, taskType, newScore: row ? Number(row.score) : q };
}
