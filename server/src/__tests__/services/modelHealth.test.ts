import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { all, get, run } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';
import { recomputeModelHealth, getHealthMap } from '../../services/modelHealth.js';

// Scoring engine step 2 (wsl's flip-window data, 2026-07-08): selection WITHIN
// the needs-eligible set had no latency/health signal, so it kept landing on
// slow/flaky models. These prove the DERIVED health summary the step-3 ranker
// consumes: computed from the requests log (passive, no probes), fast models
// score well, sustained-429 models get benched + circuit-broken.
describe('modelHealth — derived from the requests log', () => {
  let drop: () => Promise<void>;
  let fastModel: number;
  let flakyModel: number;
  let fastPlatform: string;
  let flakyPlatform: string;
  let fastModelId: string;
  let flakyModelId: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const testDb = await createTestDb();
    drop = testDb.drop;
    await initDb(testDb.connectionString);
    const rows = await all<{ id: number; platform: string; model_id: string }>(getPool(), `SELECT id, platform, model_id FROM models ORDER BY id LIMIT 2`);
    fastModel = rows[0].id; fastPlatform = rows[0].platform; fastModelId = rows[0].model_id;
    flakyModel = rows[1].id; flakyPlatform = rows[1].platform; flakyModelId = rows[1].model_id;
  });

  afterAll(async () => {
    await closeDb();
    await drop();
  });

  beforeEach(async () => {
    await run(getPool(), 'DELETE FROM requests');
    await run(getPool(), 'DELETE FROM model_health');
    await run(getPool(), `UPDATE models SET enabled = true, disabled_reason = NULL`);
  });

  async function logCall(platform: string, modelId: string, status: string, latency: number, error: string | null, minutesAgo = 1) {
    await run(getPool(), `
      INSERT INTO requests (platform, model_id, status, latency_ms, error, is_probe, created_at)
      VALUES (?, ?, ?, ?, ?, false, now() - (? || ' minutes')::interval)
    `, [platform, modelId, status, latency, error, minutesAgo]);
  }

  it('computes median latency + success rate from recent successful traffic', async () => {
    await logCall(fastPlatform, fastModelId, 'success', 100, null, 5);
    await logCall(fastPlatform, fastModelId, 'success', 200, null, 4);
    await logCall(fastPlatform, fastModelId, 'success', 300, null, 3);

    await recomputeModelHealth(getPool());
    const health = (await getHealthMap(getPool())).get(fastModel);
    expect(health).toBeDefined();
    expect(health!.recent_latency_ms).toBe(200); // median of 100/200/300
    expect(health!.recent_success_rate).toBeCloseTo(1);
    expect(health!.health_score).toBeCloseTo(1);
    expect(health!.status).toBe('healthy');
  });

  it('median latency ignores failed-call timeout artifacts (a fast model with one blip is not penalized on speed)', async () => {
    await logCall(fastPlatform, fastModelId, 'success', 120, null, 5);
    await logCall(fastPlatform, fastModelId, 'success', 130, null, 4);
    await logCall(fastPlatform, fastModelId, 'error', 15000, 'This operation was aborted', 3);

    await recomputeModelHealth(getPool());
    const health = (await getHealthMap(getPool())).get(fastModel);
    expect(health!.recent_latency_ms).toBe(130); // median over the two successes, not the 15s timeout
  });

  it('sets a circuit-breaker cooldown when the most recent call was a 429/timeout', async () => {
    await logCall(flakyPlatform, flakyModelId, 'success', 500, null, 5);
    await logCall(flakyPlatform, flakyModelId, 'error', 15000, 'Error 429: Too Many Requests', 1);

    await recomputeModelHealth(getPool());
    const health = (await getHealthMap(getPool())).get(flakyModel);
    expect(health!.cooldown_until).not.toBeNull();
    expect(new Date(health!.cooldown_until!).getTime()).toBeGreaterThan(Date.now());
  });

  it('benches a model (disabled_reason=unhealthy) after a sustained run of 429/timeouts, conservatively', async () => {
    // 6 consecutive rate-limit failures = the conservative inactive threshold.
    for (let i = 6; i >= 1; i--) {
      await logCall(flakyPlatform, flakyModelId, 'error', 15000, 'Error 429: rate limit exceeded', i);
    }

    await recomputeModelHealth(getPool());
    const model = await get<{ enabled: boolean; disabled_reason: string | null }>(getPool(), `SELECT enabled, disabled_reason FROM models WHERE id = ?`, [flakyModel]);
    expect(model!.enabled).toBe(false);
    expect(model!.disabled_reason).toBe('unhealthy');
    const health = (await getHealthMap(getPool())).get(flakyModel);
    expect(health!.status).toBe('inactive');
    expect(health!.health_score).toBeLessThanOrEqual(0.2);
  });

  it('does NOT bench a model a human disabled (disabled_reason=manual stays untouched)', async () => {
    await run(getPool(), `UPDATE models SET enabled = false, disabled_reason = 'manual' WHERE id = ?`, [flakyModel]);
    for (let i = 6; i >= 1; i--) {
      await logCall(flakyPlatform, flakyModelId, 'error', 15000, 'Error 429', i);
    }
    await recomputeModelHealth(getPool());
    const model = await get<{ disabled_reason: string | null }>(getPool(), `SELECT disabled_reason FROM models WHERE id = ?`, [flakyModel]);
    // The UPDATE only touches enabled=true rows, so 'manual' is never clobbered.
    expect(model!.disabled_reason).toBe('manual');
  });

  it('a few isolated 429s (not a tail run) penalize but do not bench', async () => {
    await logCall(flakyPlatform, flakyModelId, 'error', 15000, 'Error 429', 8);
    await logCall(flakyPlatform, flakyModelId, 'success', 400, null, 6);
    await logCall(flakyPlatform, flakyModelId, 'success', 450, null, 2);

    await recomputeModelHealth(getPool());
    const model = await get<{ enabled: boolean }>(getPool(), `SELECT enabled FROM models WHERE id = ?`, [flakyModel]);
    expect(model!.enabled).toBe(true); // last calls succeeded → tail run is 0 → healthy
    const health = (await getHealthMap(getPool())).get(flakyModel);
    expect(health!.status).toBe('healthy');
  });
});
