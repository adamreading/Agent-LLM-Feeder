import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { all, get, run, runReturningId } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';
import { checkPlatformKeyGaps } from '../../services/platformKeyWatch.js';
import { encrypt } from '../../lib/crypto.js';

async function mistralModelIds(): Promise<number[]> {
  const rows = await all<{ id: number }>(getPool(), `SELECT id FROM models WHERE platform = 'mistral'`);
  return rows.map((r) => r.id);
}

async function backdateWatch(platform: string, minutesAgo: number) {
  await run(getPool(), `UPDATE platform_key_watch SET keys_missing_since = now() - interval '${minutesAgo} minutes' WHERE platform = ?`, [platform]);
}

// Adam's directive (2026-07-08): a platform with zero usable keys for 10+
// minutes should have its models auto-disabled until a key is back. Uses a
// real (not mocked) 10-minute-ago timestamp to prove the actual elapsed-time
// comparison, not just that the function runs.
describe('checkPlatformKeyGaps — 10-minute grace period auto-disable', () => {
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

  it('does nothing while a usable key exists', async () => {
    const { encrypted, iv, authTag } = encrypt('test-mistral-key');
    await runReturningId(getPool(), `
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('mistral', 'test', ?, ?, ?, 'healthy', true)
    `, [encrypted, iv, authTag]);

    await checkPlatformKeyGaps(getPool());

    const watch = await get(getPool(), `SELECT * FROM platform_key_watch WHERE platform = 'mistral'`);
    expect(watch).toBeUndefined();
    const models = await all<{ enabled: boolean }>(getPool(), `SELECT enabled FROM models WHERE platform = 'mistral'`);
    expect(models.every((m) => m.enabled)).toBe(true);
  });

  it('starts the clock the first time a platform has zero usable keys, without disabling yet', async () => {
    await run(getPool(), `DELETE FROM api_keys WHERE platform = 'mistral'`);

    await checkPlatformKeyGaps(getPool());

    const watch = await get<{ keys_missing_since: string }>(getPool(), `SELECT keys_missing_since FROM platform_key_watch WHERE platform = 'mistral'`);
    expect(watch).toBeDefined();
    expect(watch!.keys_missing_since).not.toBeNull();

    const models = await all<{ enabled: boolean }>(getPool(), `SELECT enabled FROM models WHERE platform = 'mistral'`);
    expect(models.every((m) => m.enabled)).toBe(true); // grace period not elapsed yet
  });

  it('a human-disabled model in the same platform is left alone by the grace-period clock start', async () => {
    const ids = await mistralModelIds();
    // A human disabling a model via the UI sets disabled_reason='manual'.
    await run(getPool(), `UPDATE models SET enabled = false, disabled_reason = 'manual' WHERE id = ?`, [ids[0]]);
    await checkPlatformKeyGaps(getPool());
    const row = await get<{ enabled: boolean; disabled_reason: string | null }>(getPool(), `SELECT enabled, disabled_reason FROM models WHERE id = ?`, [ids[0]]);
    expect(row!.enabled).toBe(false);
    expect(row!.disabled_reason).toBe('manual'); // untouched by this mechanism
  });

  it('auto-disables the platform\'s (still-enabled) models once the grace period has elapsed', async () => {
    await backdateWatch('mistral', 11);

    await checkPlatformKeyGaps(getPool());

    const ids = await mistralModelIds();
    const rows = await all<{ id: number; enabled: boolean; disabled_reason: string | null }>(getPool(), `SELECT id, enabled, disabled_reason FROM models WHERE platform = 'mistral'`);
    // The human-disabled model keeps its 'manual' reason — this mechanism only
    // touches rows that were still enabled, and stamps its own 'no_key' reason.
    const humanDisabled = rows.find((r) => r.id === ids[0]);
    expect(humanDisabled!.disabled_reason).toBe('manual');
    for (const r of rows.filter((r) => r.id !== ids[0])) {
      expect(r.enabled).toBe(false);
      expect(r.disabled_reason).toBe('no_key');
    }
  });

  it('re-enables only the no_key-disabled models once a usable key returns, leaving the human-disabled one untouched', async () => {
    const { encrypted, iv, authTag } = encrypt('test-mistral-key-2');
    await runReturningId(getPool(), `
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('mistral', 'test-2', ?, ?, ?, 'healthy', true)
    `, [encrypted, iv, authTag]);

    await checkPlatformKeyGaps(getPool());

    const ids = await mistralModelIds();
    const rows = await all<{ id: number; enabled: boolean; disabled_reason: string | null }>(getPool(), `SELECT id, enabled, disabled_reason FROM models WHERE platform = 'mistral'`);
    const humanDisabled = rows.find((r) => r.id === ids[0]);
    expect(humanDisabled!.enabled).toBe(false); // still off — 'manual' is never auto-revived
    expect(humanDisabled!.disabled_reason).toBe('manual');
    for (const r of rows.filter((r) => r.id !== ids[0])) {
      expect(r.enabled).toBe(true);
      expect(r.disabled_reason).toBeNull();
    }

    const watch = await get<{ keys_missing_since: string | null }>(getPool(), `SELECT keys_missing_since FROM platform_key_watch WHERE platform = 'mistral'`);
    expect(watch!.keys_missing_since).toBeNull();
  });
});
