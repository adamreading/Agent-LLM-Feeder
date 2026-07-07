import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { all, get } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';

/**
 * Migrations V1–V9 must be idempotent: running initDb twice on the same
 * physical database should produce identical state. New migrations
 * (V10+) should be added to this test as they ship.
 */
describe('Migration idempotency', () => {
  it('initDb on a fresh DB then re-run produces identical row counts', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const testDb = await createTestDb();

    const pool1 = await initDb(testDb.connectionString);
    const before = {
      models: Number((await get<{ c: string }>(pool1, 'SELECT COUNT(*) AS c FROM models'))!.c),
      fallback: Number((await get<{ c: string }>(pool1, 'SELECT COUNT(*) AS c FROM fallback_config'))!.c),
      enabledModels: Number((await get<{ c: string }>(pool1, 'SELECT COUNT(*) AS c FROM models WHERE enabled = true'))!.c),
      disabledModels: Number((await get<{ c: string }>(pool1, 'SELECT COUNT(*) AS c FROM models WHERE enabled = false'))!.c),
      orphanFallbacks: Number((await get<{ c: string }>(pool1, `
        SELECT COUNT(*) AS c FROM fallback_config f
        LEFT JOIN models m ON f.model_db_id = m.id
        WHERE m.id IS NULL
      `))!.c),
    };
    await closeDb();

    // Re-init the same DB — V1..V11 should all no-op idempotently.
    const pool2 = await initDb(testDb.connectionString);
    const after = {
      models: Number((await get<{ c: string }>(pool2, 'SELECT COUNT(*) AS c FROM models'))!.c),
      fallback: Number((await get<{ c: string }>(pool2, 'SELECT COUNT(*) AS c FROM fallback_config'))!.c),
      enabledModels: Number((await get<{ c: string }>(pool2, 'SELECT COUNT(*) AS c FROM models WHERE enabled = true'))!.c),
      disabledModels: Number((await get<{ c: string }>(pool2, 'SELECT COUNT(*) AS c FROM models WHERE enabled = false'))!.c),
      orphanFallbacks: Number((await get<{ c: string }>(pool2, `
        SELECT COUNT(*) AS c FROM fallback_config f
        LEFT JOIN models m ON f.model_db_id = m.id
        WHERE m.id IS NULL
      `))!.c),
    };
    await closeDb();
    await testDb.drop();

    expect(after).toEqual(before);
    expect(after.orphanFallbacks).toBe(0);
  });

  describe('seeded catalog invariants', () => {
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

    it('every catalog row has exactly one fallback_config entry', async () => {
      const rows = await all<{ id: number; fb_count: string }>(getPool(), `
        SELECT m.id, COUNT(f.id) AS fb_count
          FROM models m
          LEFT JOIN fallback_config f ON m.id = f.model_db_id
         GROUP BY m.id
        HAVING COUNT(f.id) <> 1
      `);
      expect(rows).toEqual([]);
    });

    it('UNIQUE(platform, model_id) constraint holds — no duplicate catalog rows', async () => {
      const dups = await all(getPool(), `
        SELECT platform, model_id, COUNT(*) AS c FROM models
         GROUP BY platform, model_id
        HAVING COUNT(*) > 1
      `);
      expect(dups).toEqual([]);
    });

    it('all enabled catalog platforms have a registered provider', async () => {
      const { hasProvider } = await import('../../providers/index.js');

      const platforms = (await all<{ platform: any }>(getPool(),
        `SELECT DISTINCT platform FROM models WHERE enabled = true`
      )).map(r => r.platform);

      const missing = platforms.filter(p => !hasProvider(p));
      expect(missing).toEqual([]);
    });
  });
});
