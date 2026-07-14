import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { all, run } from '../../db/pgCompat.js';
import { setQuotaExhausted } from '../../services/modelHealth.js';
import { createTestDb } from '../testDb.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

// The count query the endpoint runs, replicated here so the test asserts the
// endpoint matches ground truth rather than a hard-coded number (the seed
// catalogue can change).
async function expectedLanes(): Promise<number> {
  const rows = await all<{ platform: string }>(getPool(), `
    SELECT DISTINCT m.platform
    FROM models m
    WHERE m.enabled = true AND m.kind = 'chat'
      AND EXISTS (SELECT 1 FROM api_keys k WHERE k.platform = m.platform AND k.enabled = true AND k.status <> 'invalid')
      AND NOT EXISTS (
        SELECT 1 FROM model_health h WHERE h.model_db_id = m.id
          AND ((h.cooldown_until IS NOT NULL AND h.cooldown_until > now())
            OR (h.quota_exhausted_until IS NOT NULL AND h.quota_exhausted_until > now()))
      )
  `, []);
  return rows.length;
}

describe('Swarm capacity API (/api/swarm/capacity)', () => {
  let app: Express;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const testDb = await createTestDb();
    drop = testDb.drop;
    await initDb(testDb.connectionString);
    app = createApp();

    // The test catalogue seeds models but no keys; a lane requires a configured
    // key. Seed one key per distinct platform that has an enabled chat model
    // (via the API so it's encrypted the same way production keys are).
    const platforms = await all<{ platform: string }>(getPool(),
      `SELECT DISTINCT platform FROM models WHERE enabled = true AND kind = 'chat'`, []);
    for (const { platform } of platforms) {
      await request(app, 'POST', '/api/keys', { platform, key: `test-${platform}-key` });
    }
  });

  afterAll(async () => {
    await closeDb();
    await drop();
  });

  it('returns {sessions,class,task_type}: sessions = distinct healthy provider lanes, class echoed, class→task_type mapped', async () => {
    const { status, body } = await request(app, 'GET', '/api/swarm/capacity?class=coding');
    expect(status).toBe(200);
    expect(typeof body.sessions).toBe('number');
    expect(body.sessions).toBe(await expectedLanes());
    expect(body.sessions).toBeGreaterThan(0); // seed catalogue has several keyed platforms
    expect(body.class).toBe('coding');
    expect(body.task_type).toBe('coding');
  });

  it('maps wire class to arena task_type and defaults unknown/absent to overall', async () => {
    const creative = await request(app, 'GET', '/api/swarm/capacity?class=creative');
    expect(creative.body.task_type).toBe('creative_writing'); // alias → creative_writing
    const bogus = await request(app, 'GET', '/api/swarm/capacity?class=nonsense');
    expect(bogus.body.task_type).toBe('overall');
    const bare = await request(app, 'GET', '/api/swarm/capacity');
    expect(bare.body.class).toBeNull();
    expect(bare.body.task_type).toBe('overall');
    // class is ordering-only, so the lane count is class-independent
    expect(bare.body.sessions).toBe(creative.body.sessions);
  });

  it('quota-parking every chat model on a platform removes exactly that one lane', async () => {
    const before = (await request(app, 'GET', '/api/swarm/capacity?class=coding')).body.sessions;

    // Pick one platform that currently contributes a lane, then park all its
    // enabled chat models.
    const [lane] = await all<{ platform: string }>(getPool(), `
      SELECT DISTINCT m.platform FROM models m
      WHERE m.enabled = true AND m.kind = 'chat'
        AND EXISTS (SELECT 1 FROM api_keys k WHERE k.platform = m.platform AND k.enabled = true AND k.status <> 'invalid')
      ORDER BY m.platform LIMIT 1
    `, []);
    expect(lane).toBeDefined();

    const models = await all<{ id: number }>(getPool(),
      `SELECT id FROM models WHERE platform = ? AND enabled = true AND kind = 'chat'`, [lane.platform]);
    for (const m of models) await setQuotaExhausted(getPool(), m.id, 'test-park');

    const after = (await request(app, 'GET', '/api/swarm/capacity?class=coding')).body.sessions;
    expect(after).toBe(before - 1);

    // cleanup so later tests / suites see a clean pool
    await run(getPool(), `UPDATE model_health SET quota_exhausted_until = NULL WHERE model_db_id IN (${models.map(() => '?').join(',')})`, models.map(m => m.id));
  });
});
