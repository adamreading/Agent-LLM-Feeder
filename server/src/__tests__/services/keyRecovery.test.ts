import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { all, run } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';

// Mutable mock state (hoisted so the vi.mock factory can close over it).
const h = vi.hoisted(() => ({ validateOk: true }));

vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: () => 'mocked-api-key' };
});
vi.mock('../../providers/index.js', async () => {
  const actual = await vi.importActual('../../providers/index.js');
  return { ...actual, getProvider: () => ({ validateKey: async () => h.validateOk }) };
});

// Import AFTER the mocks are declared.
const { reviveRecoverableKeys } = await import('../../services/health.js');

async function seedKey(platform: string, enabled: boolean, status: string, lastChecked: 'old' | 'now' | 'null') {
  const ts = lastChecked === 'old' ? "now() - interval '1 hour'" : lastChecked === 'now' ? 'now()' : 'NULL';
  await run(getPool(),
    `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, last_checked_at)
     VALUES (?, ?, 'x', 'x', 'x', ?, ?, ${ts})`,
    [platform, platform + '-key', status, enabled]);
}
async function enabledOf(platform: string): Promise<boolean> {
  const rows = await all<{ enabled: boolean }>(getPool(), 'SELECT enabled FROM api_keys WHERE platform = ?', [platform]);
  return rows[0]?.enabled === true;
}

describe('reviveRecoverableKeys — self-heal transiently-disabled keys', () => {
  let drop: () => Promise<void>;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const testDb = await createTestDb();
    drop = testDb.drop;
    await initDb(testDb.connectionString);
  });
  afterAll(async () => { await closeDb(); await drop(); });
  beforeEach(async () => { await run(getPool(), 'DELETE FROM api_keys'); h.validateOk = true; });

  it('re-enables a disabled+invalid key that now validates', async () => {
    await seedKey('groq', false, 'invalid', 'old');
    h.validateOk = true;
    await reviveRecoverableKeys(getPool());
    expect(await enabledOf('groq')).toBe(true);
  });

  it('leaves a human-disabled HEALTHY key alone (status != invalid)', async () => {
    await seedKey('mistral', false, 'healthy', 'old');
    h.validateOk = true;
    await reviveRecoverableKeys(getPool());
    expect(await enabledOf('mistral')).toBe(false);
  });

  it('leaves a genuinely-dead key disabled when it still fails to validate', async () => {
    await seedKey('cohere', false, 'invalid', 'old');
    h.validateOk = false;
    await reviveRecoverableKeys(getPool());
    expect(await enabledOf('cohere')).toBe(false);
  });

  it('respects the backoff: a recently-checked disabled+invalid key is skipped', async () => {
    await seedKey('nvidia', false, 'invalid', 'now'); // checked < 15min ago
    h.validateOk = true;
    await reviveRecoverableKeys(getPool());
    expect(await enabledOf('nvidia')).toBe(false);
  });
});
