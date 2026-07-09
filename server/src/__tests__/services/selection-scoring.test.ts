import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { routeRequest } from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run, all } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';
import { encrypt } from '../../lib/crypto.js';

// Quota is not what these tests are about — force every key available so the
// ONLY thing steering selection is the step-3 health/latency ordering.
vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(() => true),
    canUseTokens: vi.fn(() => true),
    isOnCooldown: vi.fn(() => false),
  };
});

async function addKey(platform: string) {
  const { encrypted, iv, authTag } = encrypt(`test-${platform}-key`);
  await run(getPool(), `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, 'test', ?, ?, ?, 'healthy', true)`, [platform, encrypted, iv, authTag]);
}

// Isolate to exactly these model db ids (disable all other fallback entries),
// so a route call can only choose among them.
async function isolate(ids: number[]) {
  await run(getPool(), 'UPDATE fallback_config SET enabled = false');
  for (const id of ids) await run(getPool(), 'UPDATE fallback_config SET enabled = true WHERE model_db_id = ?', [id]);
}

async function setHealth(modelDbId: number, fields: { latency?: number | null; health?: number; cooldownMs?: number | null }) {
  await run(getPool(), `
    INSERT INTO model_health (model_db_id, health_score, recent_latency_ms, cooldown_until, updated_at)
    VALUES (?, ?, ?, ?, now())
    ON CONFLICT (model_db_id) DO UPDATE SET health_score = EXCLUDED.health_score, recent_latency_ms = EXCLUDED.recent_latency_ms, cooldown_until = EXCLUDED.cooldown_until, updated_at = now()
  `, [modelDbId, fields.health ?? 1, fields.latency ?? null, fields.cooldownMs != null ? new Date(Date.now() + fields.cooldownMs) : null]);
}

// Step-3 selection ordering (wsl's flip-window data, 2026-07-08): within the
// needs-eligible set, prefer healthy+fast instances instead of walking a
// priority list blind to latency/health.
describe('Step-3 health/latency-aware selection', () => {
  let drop: () => Promise<void>;
  let groqModels: { id: number; model_id: string }[];

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const testDb = await createTestDb();
    drop = testDb.drop;
    await initDb(testDb.connectionString);
    groqModels = await all<{ id: number; model_id: string }>(getPool(), `SELECT id, model_id FROM models WHERE platform = 'groq' ORDER BY id LIMIT 2`);
  });

  afterAll(async () => {
    await closeDb();
    await drop();
  });

  beforeEach(async () => {
    await run(getPool(), 'DELETE FROM api_keys');
    await run(getPool(), 'DELETE FROM model_health');
    await run(getPool(), 'UPDATE fallback_config SET enabled = true');
    vi.clearAllMocks();
    (ratelimit.canMakeRequest as any).mockReturnValue(true);
    (ratelimit.canUseTokens as any).mockReturnValue(true);
    (ratelimit.isOnCooldown as any).mockReturnValue(false);
  });

  it('with a tight latency ceiling, picks the far-faster instance even if it has worse base priority', async () => {
    const [a, b] = groqModels;
    await isolate([a.id, b.id]);
    await addKey('groq');
    // a: slow (20s). b: fast (50ms). Tight ceiling → latency dominates → b wins.
    await setHealth(a.id, { latency: 20000, health: 1 });
    await setHealth(b.id, { latency: 50, health: 1 });

    const route = await routeRequest({ latencyCeilingMs: 8000 });
    expect(route.modelId).toBe(b.model_id);
  });

  it('deprioritizes an unhealthy instance in favor of a healthy one', async () => {
    const [a, b] = groqModels;
    await isolate([a.id, b.id]);
    await addKey('groq');
    await setHealth(a.id, { latency: 500, health: 0.1 }); // flaky
    await setHealth(b.id, { latency: 500, health: 1.0 }); // healthy

    const route = await routeRequest({});
    expect(route.modelId).toBe(b.model_id);
  });

  it('circuit-breaker: skips an instance whose cooldown is live, choosing the other', async () => {
    const [a, b] = groqModels;
    await isolate([a.id, b.id]);
    await addKey('groq');
    // a would win on latency, but it's circuit-broken → must be skipped.
    await setHealth(a.id, { latency: 50, health: 1, cooldownMs: 60_000 });
    await setHealth(b.id, { latency: 5000, health: 1 });

    const route = await routeRequest({});
    expect(route.modelId).toBe(b.model_id);
  });

  it('an all-cooled eligible pool surfaces as ALL_RATE_LIMITED (transient), not NO_ELIGIBLE_MODEL', async () => {
    const [a, b] = groqModels;
    await isolate([a.id, b.id]);
    await addKey('groq');
    await setHealth(a.id, { latency: 50, cooldownMs: 60_000 });
    await setHealth(b.id, { latency: 50, cooldownMs: 60_000 });

    await expect(routeRequest({})).rejects.toMatchObject({ code: 'ALL_RATE_LIMITED' });
  });

  it('with no health data, base ordering follows intelligence_rank (lowest rank wins)', async () => {
    const [a, b] = groqModels;
    await isolate([a.id, b.id]);
    await addKey('groq');
    // No model_health rows at all. The base ordering prior is intelligence_rank
    // now (not the drift-prone fallback_config.priority). Give a the better rank.
    await run(getPool(), 'UPDATE models SET intelligence_rank = 3 WHERE id = ?', [a.id]);
    await run(getPool(), 'UPDATE models SET intelligence_rank = 9 WHERE id = ?', [b.id]);

    const route = await routeRequest({});
    expect(route.modelId).toBe(a.model_id);
  });
});
