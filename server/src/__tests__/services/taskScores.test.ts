import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { get, runReturningId } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';
import {
  recordTaskScore, getTaskScores, getBestTaskScore,
  recordBenchmarkAlias, resolveBenchmarkAlias,
} from '../../services/taskScores.js';

describe('taskScores service', () => {
  let drop: () => Promise<void>;
  let canonicalId: number;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const testDb = await createTestDb();
    drop = testDb.drop;
    await initDb(testDb.connectionString);
    canonicalId = await runReturningId(getPool(), `INSERT INTO canonical_models (name, slug) VALUES ('Test Model', 'test-model')`, []);
  });

  afterAll(async () => {
    await closeDb();
    await drop();
  });

  it('records and reads back a benchmark task score', async () => {
    await recordTaskScore(getPool(), canonicalId, { taskType: 'coding', score: 0.87, rank: 3, evidence: 'lmarena coding leaderboard' });
    const scores = await getTaskScores(getPool(), canonicalId);
    const coding = scores.find((s) => s.task_type === 'coding');
    expect(coding).toBeDefined();
    expect(coding!.score).toBeCloseTo(0.87);
    expect(coding!.rank).toBe(3);
    expect(coding!.source).toBe('benchmark');
  });

  it('upserts (not duplicates) on the same canonical+task+source', async () => {
    await recordTaskScore(getPool(), canonicalId, { taskType: 'coding', score: 0.90 });
    const scores = (await getTaskScores(getPool(), canonicalId)).filter((s) => s.task_type === 'coding');
    expect(scores.length).toBe(1);
    expect(scores[0].score).toBeCloseTo(0.90);
  });

  it('getBestTaskScore prefers measured over benchmark for the same task', async () => {
    await recordTaskScore(getPool(), canonicalId, { taskType: 'math', score: 0.60, source: 'benchmark' });
    await recordTaskScore(getPool(), canonicalId, { taskType: 'math', score: 0.75, source: 'measured' });
    const best = await getBestTaskScore(getPool(), canonicalId, 'math');
    expect(best).not.toBeNull();
    expect(best!.source).toBe('measured');
    expect(best!.score).toBeCloseTo(0.75);
  });

  it('getBestTaskScore returns null for an unscored task (cold-start signal, not 0)', async () => {
    const best = await getBestTaskScore(getPool(), canonicalId, 'creative_writing');
    expect(best).toBeNull();
  });

  it('benchmark alias resolves external naming to the canonical via the shared normalize fingerprint', async () => {
    await recordBenchmarkAlias(getPool(), canonicalId, 'Test-Model-Latest');
    // A differently-spelled external name that normalizes to the same key resolves.
    const resolved = await resolveBenchmarkAlias(getPool(), 'test_model-latest');
    expect(resolved).toBe(canonicalId);
  });

  it('resolveBenchmarkAlias returns null for an unknown external name (queues for review, never guesses)', async () => {
    const resolved = await resolveBenchmarkAlias(getPool(), 'some-model-we-have-never-seen');
    expect(resolved).toBeNull();
  });

  it('recordBenchmarkAlias is idempotent on the same normalized key', async () => {
    await recordBenchmarkAlias(getPool(), canonicalId, 'Test Model');
    await recordBenchmarkAlias(getPool(), canonicalId, 'test-model');
    const count = await get<{ c: string }>(getPool(), `SELECT COUNT(*) as c FROM benchmark_aliases WHERE canonical_model_id = ?`, [canonicalId]);
    // 'Test-Model-Latest' + 'Test Model'/'test-model' both normalize to 'testmodel' -> single alias row.
    expect(Number(count!.c)).toBe(1);
  });
});
