import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { initEncryptionKey, encrypt, decrypt } from '../../lib/crypto.js';
import { run, get } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';

describe('initEncryptionKey — input validation', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const testDb = await createTestDb();
    drop = testDb.drop;
    pool = new pg.Pool({ connectionString: testDb.connectionString });
  });

  afterAll(async () => {
    await pool.end();
    await drop();
  });

  beforeEach(async () => {
    delete process.env.ENCRYPTION_KEY;
    await run(pool, "DELETE FROM settings WHERE key = 'encryption_key'");
  });

  it('accepts a valid 64-char hex env key', async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    await expect(initEncryptionKey(pool)).resolves.not.toThrow();
    // Round-trip a value to confirm the key actually works.
    const enc = encrypt('hello');
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('hello');
  });

  it('throws on too-short env key (typo guard)', async () => {
    process.env.ENCRYPTION_KEY = 'abc';
    await expect(initEncryptionKey(pool)).rejects.toThrow(/Invalid ENCRYPTION_KEY \(env\).+expected 64 hex chars/);
  });

  it('throws on too-long env key', async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(80);
    await expect(initEncryptionKey(pool)).rejects.toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('throws on non-hex env key of correct length', async () => {
    process.env.ENCRYPTION_KEY = 'g'.repeat(64); // g is not hex
    await expect(initEncryptionKey(pool)).rejects.toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('still treats the placeholder as "not set" and falls through to DB / generation', async () => {
    process.env.ENCRYPTION_KEY = 'your-64-char-hex-key-here';
    await expect(initEncryptionKey(pool)).resolves.not.toThrow();
    // Fell through to generation — DB now has a key.
    const row = await get<{ value: string }>(pool, "SELECT value FROM settings WHERE key = 'encryption_key'");
    expect(row!.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on a corrupted DB-stored key', async () => {
    await run(pool, "INSERT INTO settings (key, value) VALUES ('encryption_key', ?)", ['not-hex']);
    await expect(initEncryptionKey(pool)).rejects.toThrow(/Invalid ENCRYPTION_KEY \(db\)/);
  });

  it('generates a fresh key on a virgin DB and persists it', async () => {
    await initEncryptionKey(pool);
    const row = await get<{ value: string }>(pool, "SELECT value FROM settings WHERE key = 'encryption_key'");
    expect(row!.value).toMatch(/^[0-9a-f]{64}$/);
  });
});
