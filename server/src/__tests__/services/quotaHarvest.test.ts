import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { harvestQuotaHeaders } from '../../services/quotaHarvest.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run, get, all } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';
import { encrypt } from '../../lib/crypto.js';

describe('P3: quota header harvest', () => {
  let drop: () => Promise<void>;
  let keyId: number;

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
    await run(pool, 'DELETE FROM quota_snapshots');
    await run(pool, 'DELETE FROM api_keys');
    const { encrypted, iv, authTag } = encrypt('test-key');
    await run(pool, `
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', true)
    `, [encrypted, iv, authTag]);
    const row = await get<{ id: number }>(pool, `SELECT id FROM api_keys WHERE platform = 'groq'`);
    keyId = row!.id;
  });

  it('does nothing when no headers were sent (never records a false zero)', async () => {
    await harvestQuotaHeaders('groq', 'test-model', keyId, undefined);
    const rows = await all(getPool(), 'SELECT * FROM quota_snapshots');
    expect(rows).toHaveLength(0);
  });

  it('records token-based quota when present', async () => {
    await harvestQuotaHeaders('groq', 'test-model', keyId, {
      'x-ratelimit-remaining-tokens': '4500',
      'x-ratelimit-limit-tokens': '6000',
      'x-ratelimit-reset-tokens': '7m12s',
    });
    const row = await get<any>(getPool(), 'SELECT * FROM quota_snapshots WHERE platform = ? AND model_id = ?', ['groq', 'test-model']);
    expect(Number(row.quota_remaining)).toBe(4500);
    expect(Number(row.quota_limit)).toBe(6000);
    expect(row.reset_at).not.toBeNull();
    // 7m12s = 432s from observation time
    const deltaMs = new Date(row.reset_at).getTime() - new Date(row.observed_at).getTime();
    expect(deltaMs).toBeGreaterThan(430_000);
    expect(deltaMs).toBeLessThan(435_000);
  });

  it('falls back to request-based quota when token headers are absent', async () => {
    await harvestQuotaHeaders('groq', 'test-model', keyId, {
      'x-ratelimit-remaining-requests': '10',
      'x-ratelimit-limit-requests': '20',
    });
    const row = await get<any>(getPool(), 'SELECT * FROM quota_snapshots WHERE platform = ? AND model_id = ?', ['groq', 'test-model']);
    expect(Number(row.quota_remaining)).toBe(10);
    expect(Number(row.quota_limit)).toBe(20);
  });

  it('upserts — a second harvest updates the same row rather than creating a new one', async () => {
    await harvestQuotaHeaders('groq', 'test-model', keyId, { 'x-ratelimit-remaining-tokens': '6000' });
    await harvestQuotaHeaders('groq', 'test-model', keyId, { 'x-ratelimit-remaining-tokens': '5990' });
    const rows = await all<any>(getPool(), 'SELECT * FROM quota_snapshots WHERE platform = ? AND model_id = ?', ['groq', 'test-model']);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].quota_remaining)).toBe(5990);
  });

  it('leaves reset_at null for an unparseable reset value rather than guessing', async () => {
    await harvestQuotaHeaders('groq', 'test-model', keyId, {
      'x-ratelimit-remaining-tokens': '100',
      'x-ratelimit-reset-tokens': 'not-a-duration',
    });
    const row = await get<any>(getPool(), 'SELECT * FROM quota_snapshots WHERE platform = ? AND model_id = ?', ['groq', 'test-model']);
    expect(row.reset_at).toBeNull();
  });
});
