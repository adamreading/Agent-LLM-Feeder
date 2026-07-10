import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { recordRealtimeQuality } from '../../services/modelPerf.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run, get } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';

// Real-usage quality ingestion → task_scores source='realtime_quality' (EWMA),
// mapped model_ref → canonical (Adam's dynamic-evolving-scoring, 2026-07-10).
describe('modelPerf — realtime_quality ingestion', () => {
  let drop: () => Promise<void>;
  let canonicalId: number;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const testDb = await createTestDb();
    drop = testDb.drop;
    await initDb(testDb.connectionString);
  });

  afterAll(async () => {
    await closeDb();
    await drop();
  });

  beforeEach(async () => {
    const pool = getPool();
    // Delete the child models row BEFORE its canonical parent (models.canonical_model_id
    // FK has no ON DELETE CASCADE), else the canonical delete violates the FK.
    await run(pool, `DELETE FROM models WHERE model_id = 'perf-model'`);
    await run(pool, `DELETE FROM canonical_models WHERE slug = 'perf-canon'`);
    const c = await get<{ id: number }>(pool, `INSERT INTO canonical_models (name, slug) VALUES ('Perf Canon', 'perf-canon') RETURNING id`);
    canonicalId = c!.id;
    // A models instance linked to the canonical, so platform/model_id resolves.
    await run(pool, `
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, canonical_model_id)
      VALUES ('groq', 'perf-model', 'Perf Model', 30, 30, ?)
    `, [canonicalId]);
  });

  async function rtScore(taskType: string) {
    return get<{ score: number }>(getPool(),
      `SELECT score FROM task_scores WHERE canonical_model_id = ? AND task_type = ? AND source = 'realtime_quality'`,
      [canonicalId, taskType]);
  }

  it('records a first sample as the seed score, resolved via platform/model_id', async () => {
    const r = await recordRealtimeQuality(getPool(), { modelRef: 'groq/perf-model', taskClass: 'coding', qualityScore: 0.8 });
    expect(r.ok).toBe(true);
    expect(r.taskType).toBe('coding');
    const row = await rtScore('coding');
    expect(Number(row!.score)).toBeCloseTo(0.8, 5);
  });

  it('EWMA-blends a second sample toward the new value (does not overwrite)', async () => {
    await recordRealtimeQuality(getPool(), { modelRef: 'groq/perf-model', taskClass: 'coding', qualityScore: 1.0 });
    await recordRealtimeQuality(getPool(), { modelRef: 'groq/perf-model', taskClass: 'coding', qualityScore: 0.0 });
    // alpha 0.25: 1.0*0.75 + 0.0*0.25 = 0.75
    const row = await rtScore('coding');
    expect(Number(row!.score)).toBeCloseTo(0.75, 5);
  });

  it('resolves a bare model_id and a canonical slug too', async () => {
    const byBare = await recordRealtimeQuality(getPool(), { modelRef: 'perf-model', taskClass: 'math', qualityScore: 0.5 });
    expect(byBare.ok).toBe(true);
    const bySlug = await recordRealtimeQuality(getPool(), { modelRef: 'perf-canon', taskClass: 'math', qualityScore: 0.5 });
    expect(bySlug.ok).toBe(true);
    expect(bySlug.canonicalId).toBe(canonicalId);
  });

  it('maps an unknown task_class to overall', async () => {
    const r = await recordRealtimeQuality(getPool(), { modelRef: 'perf-canon', taskClass: 'something-unknown', qualityScore: 0.6 });
    expect(r.taskType).toBe('overall');
  });

  it('rejects an out-of-range score', async () => {
    const r = await recordRealtimeQuality(getPool(), { modelRef: 'perf-canon', qualityScore: 1.5 });
    expect(r.ok).toBe(false);
  });

  it('returns not-ok for an unresolvable model ref', async () => {
    const r = await recordRealtimeQuality(getPool(), { modelRef: 'no-such-model-anywhere', qualityScore: 0.5 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no canonical');
  });
});
