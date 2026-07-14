import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { routeRequest, RoutingError } from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run, get } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';

vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return { ...actual, canMakeRequest: vi.fn(() => true), canUseTokens: vi.fn(() => true), isOnCooldown: vi.fn(() => false) };
});
vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

// Two models on DIFFERENT platforms so anti-affinity can distinguish them.
// google/pro is top-ranked (picked first with no exclusion); groq/fast second.
describe('Swarm anti-affinity (swarmExcludeProviders)', () => {
  let drop: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    drop = testDb.drop;
    const pool = await initDb(testDb.connectionString);

    await run(pool, "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('google', 'gemini-pro', 'Pro', 1, 1, true)");
    await run(pool, "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('groq', 'fast-8b', 'Fast', 2, 2, true)");
    const pro = await get<{ id: number }>(pool, "SELECT id FROM models WHERE model_id = 'gemini-pro'");
    const fast = await get<{ id: number }>(pool, "SELECT id FROM models WHERE model_id = 'fast-8b'");
    await run(pool, "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, true)", [pro!.id]);
    await run(pool, "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, true)", [fast!.id]);
    await run(pool, "UPDATE fallback_config SET enabled = false WHERE model_db_id NOT IN (?, ?)", [pro!.id, fast!.id]);
    await run(pool, "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'G', 'enc', 'iv', 'tag', 'healthy', true)");
    await run(pool, "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq', 'Q', 'enc', 'iv', 'tag', 'healthy', true)");
    vi.clearAllMocks();
    (ratelimit.canMakeRequest as any).mockReturnValue(true);
    (ratelimit.canUseTokens as any).mockReturnValue(true);
  });

  afterEach(async () => {
    await closeDb();
    await drop();
  });

  it('without exclusion, picks the top-ranked platform (google)', async () => {
    const r = await routeRequest({ estimatedTokens: 100 });
    expect(r.platform).toBe('google');
  });

  it('excluding the top platform routes to the sibling-free platform (groq)', async () => {
    const r = await routeRequest({ estimatedTokens: 100, swarmExcludeProviders: new Set(['google']) });
    expect(r.platform).toBe('groq');
  });

  it('excluding ALL platforms surfaces ALL_RATE_LIMITED (429), NOT NO_ELIGIBLE_MODEL (422) — sibling-occupancy is transient', async () => {
    let err: any;
    try {
      await routeRequest({ estimatedTokens: 100, swarmExcludeProviders: new Set(['google', 'groq']) });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RoutingError);
    expect(err.code).toBe('ALL_RATE_LIMITED');
    expect(err.status).toBe(429);
  });

  it('excludeProviders (structural) on all platforms gives NO_ELIGIBLE_MODEL (422) — contrast with swarm exclusion', async () => {
    let err: any;
    try {
      await routeRequest({ estimatedTokens: 100, excludeProviders: new Set(['google', 'groq']) });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RoutingError);
    expect(err.code).toBe('NO_ELIGIBLE_MODEL');
    expect(err.status).toBe(422);
  });
});
