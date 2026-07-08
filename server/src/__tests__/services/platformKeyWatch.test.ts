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
    await run(getPool(), `UPDATE models SET enabled = false WHERE id = ?`, [ids[0]]);
    await checkPlatformKeyGaps(getPool());
    const row = await get<{ enabled: boolean; auto_disabled_no_key: boolean }>(getPool(), `SELECT enabled, auto_disabled_no_key FROM models WHERE id = ?`, [ids[0]]);
    expect(row!.enabled).toBe(false);
    expect(row!.auto_disabled_no_key).toBe(false); // was never touched by this mechanism
  });

  it('auto-disables the platform\'s (still-enabled) models once the grace period has elapsed', async () => {
    await backdateWatch('mistral', 11);

    await checkPlatformKeyGaps(getPool());

    const ids = await mistralModelIds();
    const rows = await all<{ id: number; enabled: boolean; auto_disabled_no_key: boolean }>(getPool(), `SELECT id, enabled, auto_disabled_no_key FROM models WHERE platform = 'mistral'`);
    // The one model a human already disabled in the prior test stays exactly
    // as it was (enabled=false, auto_disabled_no_key still false) — proves
    // this mechanism doesn't stamp its flag on rows it didn't itself disable.
    const humanDisabled = rows.find((r) => r.id === ids[0]);
    expect(humanDisabled!.auto_disabled_no_key).toBe(false);
    // Every OTHER model on the platform is now auto-disabled and flagged.
    for (const r of rows.filter((r) => r.id !== ids[0])) {
      expect(r.enabled).toBe(false);
      expect(r.auto_disabled_no_key).toBe(true);
    }
  });

  it('re-enables only the auto-disabled models once a usable key returns, leaving the human-disabled one untouched', async () => {
    const { encrypted, iv, authTag } = encrypt('test-mistral-key-2');
    await runReturningId(getPool(), `
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('mistral', 'test-2', ?, ?, ?, 'healthy', true)
    `, [encrypted, iv, authTag]);

    await checkPlatformKeyGaps(getPool());

    const ids = await mistralModelIds();
    const rows = await all<{ id: number; enabled: boolean; auto_disabled_no_key: boolean }>(getPool(), `SELECT id, enabled, auto_disabled_no_key FROM models WHERE platform = 'mistral'`);
    const humanDisabled = rows.find((r) => r.id === ids[0]);
    expect(humanDisabled!.enabled).toBe(false); // still off — a human turned this off, the key returning shouldn't override that
    for (const r of rows.filter((r) => r.id !== ids[0])) {
      expect(r.enabled).toBe(true);
      expect(r.auto_disabled_no_key).toBe(false);
    }

    const watch = await get<{ keys_missing_since: string | null }>(getPool(), `SELECT keys_missing_since FROM platform_key_watch WHERE platform = 'mistral'`);
    expect(watch!.keys_missing_since).toBeNull();
  });
});
