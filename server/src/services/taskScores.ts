import type pg from 'pg';
import { all, get, run } from '../db/pgCompat.js';
import { normalizeModelId } from './modelCanon.js';

// The task-type taxonomy — mirrors lmarena's category leaderboards (Adam's
// benchmark-only quality choice, 2026-07-08). Held here as a plain constant,
// NOT a DB enum/FK: task_scores.task_type is free text precisely so this list
// can grow/shrink as lmarena's categories evolve without a schema migration.
// 'overall' is the whole-arena ELO; the rest are lmarena's category cuts.
export const TASK_TYPES = [
  'overall',
  'coding',
  'math',
  'reasoning',
  'creative_writing',
  'instruction_following',
  'long_query',
  'multi_turn',
] as const;

export type TaskType = string;

export interface TaskScoreInput {
  taskType: string;
  score: number; // 0-1 normalized within the category
  rank?: number | null;
  source?: 'benchmark' | 'measured' | 'declared';
  evidence?: string | null;
}

// Upsert a quality score for a canonical model + task type. source defaults to
// 'benchmark' (lmarena). One row per (canonical, task_type, source) — a
// 'benchmark' and a (future) 'measured' score for the same task coexist, same
// declared/measured discipline as model_capabilities.
export async function recordTaskScore(pool: pg.Pool, canonicalModelId: number, input: TaskScoreInput): Promise<void> {
  const source = input.source ?? 'benchmark';
  await run(pool, `
    INSERT INTO task_scores (canonical_model_id, task_type, score, rank, source, evidence, measured_at)
    VALUES (?, ?, ?, ?, ?, ?, now())
    ON CONFLICT (canonical_model_id, task_type, source)
    DO UPDATE SET score = EXCLUDED.score, rank = EXCLUDED.rank, evidence = EXCLUDED.evidence, measured_at = now()
  `, [canonicalModelId, input.taskType, input.score, input.rank ?? null, source, input.evidence ?? null]);
}

export interface TaskScoreRow {
  task_type: string;
  score: number;
  rank: number | null;
  source: string;
  evidence: string | null;
  measured_at: string;
}

export async function getTaskScores(pool: pg.Pool, canonicalModelId: number): Promise<TaskScoreRow[]> {
  return all<TaskScoreRow>(pool, `
    SELECT task_type, score, rank, source, evidence, measured_at
    FROM task_scores WHERE canonical_model_id = ? ORDER BY task_type ASC, source ASC
  `, [canonicalModelId]);
}

// The quality input to the routing blend (step 3): the best-known score for a
// canonical model at a given task type. Prefers 'measured' over 'benchmark'
// over 'declared' when multiple sources exist — a score we verified beats an
// external leaderboard claim beats a docs claim, same trust order as
// capabilities. Returns null when we have no score at all (caller decides the
// cold-start prior — deliberately NOT defaulted to 0 here, since 0 would
// permanently starve an unscored model of the traffic it needs to earn data).
export async function getBestTaskScore(pool: pg.Pool, canonicalModelId: number, taskType: string): Promise<{ score: number; source: string } | null> {
  const row = await get<{ score: number; source: string }>(pool, `
    SELECT score, source FROM task_scores
    WHERE canonical_model_id = ? AND task_type = ?
    ORDER BY CASE source WHEN 'measured' THEN 0 WHEN 'benchmark' THEN 1 ELSE 2 END
    LIMIT 1
  `, [canonicalModelId, taskType]);
  return row ?? null;
}

// Resolve an external benchmark's model name (e.g. lmarena's spelling) to a
// canonical model via the benchmark_aliases table. Reuses the same normalize
// fingerprint as supplier matching so "GPT-OSS-120B" / "gpt-oss-120b" /
// "openai/gpt-oss-120b" all collapse identically. Returns null when unmatched
// — the ingest (step 4) queues those for the same human review as unmatched
// suppliers rather than guessing a link.
export async function resolveBenchmarkAlias(pool: pg.Pool, benchmarkModelName: string): Promise<number | null> {
  const key = normalizeModelId(benchmarkModelName);
  const row = await get<{ canonical_model_id: number }>(pool, `SELECT canonical_model_id FROM benchmark_aliases WHERE alias_key = ?`, [key]);
  return row?.canonical_model_id ?? null;
}

// Teach the benchmark alias table a name→canonical link (called when a human
// resolves an unmatched benchmark row, or when the ingest finds an exact
// normalized match to an existing supplier-derived canonical). Idempotent.
export async function recordBenchmarkAlias(pool: pg.Pool, canonicalModelId: number, benchmarkModelName: string): Promise<void> {
  const key = normalizeModelId(benchmarkModelName);
  const existing = await get<{ canonical_model_id: number }>(pool, `SELECT canonical_model_id FROM benchmark_aliases WHERE alias_key = ?`, [key]);
  if (existing) return;
  await run(pool, `INSERT INTO benchmark_aliases (canonical_model_id, alias_key) VALUES (?, ?)`, [canonicalModelId, key]);
}
