import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { all, run } from '../../db/pgCompat.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest } from '../../services/router.js';
import { createTestDb } from '../testDb.js';

describe('Router', () => {
  let drop: () => Promise<void>;

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
    await run(pool, 'DELETE FROM api_keys');
    // Reset fallback order to intelligence ranking
    const models = await all<any>(pool, 'SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC');
    for (let i = 0; i < models.length; i++) {
      await run(pool, 'UPDATE fallback_config SET priority = ? WHERE model_db_id = ?', [i + 1, models[i].id]);
    }
  });

  it('should throw when no keys are configured', async () => {
    await expect(routeRequest()).rejects.toThrow(/exhausted/i);
  });

  it('should route to highest priority model with available key', async () => {
    const pool = getPool();
    const { encrypted, iv, authTag } = encrypt('test-groq-key');
    await run(pool, `
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, ['groq', 'test', encrypted, iv, authTag, 'healthy', true]);

    const result = await routeRequest();
    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
  });

  it('should prefer higher-priority model when keys exist for multiple platforms', async () => {
    const pool = getPool();

    const googleKey = encrypt('test-google-key');
    await run(pool, `
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, ['google', 'test', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', true]);

    const groqKey = encrypt('test-groq-key');
    await run(pool, `
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, ['groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', true]);

    // Post-V6: Google's gemini-3.1-pro-preview (rank 1, free-tier-eligible per
    // probe on 2026-04-25) outranks Groq's best free-tier model openai/gpt-oss-120b
    // (rank 6). With keys for both platforms, Google wins.
    const result = await routeRequest();
    expect(result.platform).toBe('google');
  });

  it('should skip disabled keys', async () => {
    const pool = getPool();

    const googleKey = encrypt('test-google-key');
    await run(pool, `
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, ['google', 'disabled', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', false]);

    const groqKey = encrypt('test-groq-key');
    await run(pool, `
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, ['groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', true]);

    const result = await routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('should skip invalid keys', async () => {
    const pool = getPool();

    const invalidKey = encrypt('invalid-key');
    await run(pool, `
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, ['google', 'invalid', invalidKey.encrypted, invalidKey.iv, invalidKey.authTag, 'invalid', true]);

    const groqKey = encrypt('test-groq-key');
    await run(pool, `
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, ['groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', true]);

    const result = await routeRequest();
    expect(result.platform).toBe('groq');
  });
});
