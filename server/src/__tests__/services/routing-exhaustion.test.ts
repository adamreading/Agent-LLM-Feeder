import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { routeRequest } from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run, get, all } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';
import * as crypto from '../../lib/crypto.js';

// Mock ratelimit to control quota availability
vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(),
    canUseTokens: vi.fn(),
    isOnCooldown: vi.fn(() => false),
  };
});

// Mock crypto to avoid IV errors
vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return {
    ...actual,
    decrypt: vi.fn(() => 'mocked-api-key'),
  };
});

describe('Routing Key Exhaustion', () => {
  let drop: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    drop = testDb.drop;
    const pool = await initDb(testDb.connectionString);

    // Setup: 2 models (Pro and Flash)
    // Pro is higher priority (priority 1), Flash is lower (priority 2)
    await run(pool, "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('google', 'gemini-1.5-pro', 'Pro', 1, 1, true)");
    await run(pool, "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('google', 'gemini-1.5-flash', 'Flash', 2, 2, true)");

    const proRow = await get<{ id: number }>(pool, "SELECT id FROM models WHERE model_id = 'gemini-1.5-pro'");
    const flashRow = await get<{ id: number }>(pool, "SELECT id FROM models WHERE model_id = 'gemini-1.5-flash'");
    const proId = proRow!.id;
    const flashId = flashRow!.id;

    await run(pool, "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, true)", [proId]);
    await run(pool, "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, true)", [flashId]);

    // Setup: 2 keys for Google
    await run(pool, "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key A', 'enc', 'iv', 'tag', 'healthy', true)");
    await run(pool, "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key B', 'enc', 'iv', 'tag', 'healthy', true)");

    vi.clearAllMocks();
  });

  afterEach(async () => {
    await closeDb();
    await drop();
  });

  it('should skip exhausted Key B and use functional Key A for the same high-priority model', async () => {
    const pool = getPool();
    const keys = await all<any>(pool, 'SELECT id, label FROM api_keys');
    const keyA = keys.find((k: any) => k.label === 'Key A');
    const keyB = keys.find((k: any) => k.label === 'Key B');

    // Mock behavior:
    // Key B is exhausted (returns false for canMakeRequest)
    // Key A is functional (returns true)
    (ratelimit.canMakeRequest as any).mockImplementation((platform: string, modelId: string, keyId: number) => {
      if (keyId === keyB.id) return false;
      if (keyId === keyA.id) return true;
      return true;
    });
    (ratelimit.canUseTokens as any).mockReturnValue(true);

    // Act: Route request
    const result = await routeRequest(100);

    // Assert: It should have picked the Pro model despite Key B being exhausted
    expect(result.modelId).toBe('gemini-1.5-pro');
    expect(result.keyId).toBe(keyA.id);
    expect(ratelimit.canMakeRequest).toHaveBeenCalled();
  });

  it('should throw 429 when every key on every model is exhausted', async () => {
    (ratelimit.canMakeRequest as any).mockReturnValue(false);
    await expect(routeRequest(100)).rejects.toThrow(/All models exhausted/);
  });

  it('should fall back to Flash when Pro is exhausted but Flash has quota', async () => {
    (ratelimit.canMakeRequest as any).mockImplementation((_platform: string, modelId: string) => {
      if (modelId === 'gemini-1.5-pro') return false;
      if (modelId === 'gemini-1.5-flash') return true;
      return true;
    });
    (ratelimit.canUseTokens as any).mockReturnValue(true);

    const result = await routeRequest(100);
    expect(result.modelId).toBe('gemini-1.5-flash');
  });
});
