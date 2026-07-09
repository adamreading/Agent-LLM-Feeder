import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, closeDb } from '../../db/index.js';
import { createTestDb } from '../testDb.js';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Fallback API (read-only reality view)', () => {
  let app: Express;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const testDb = await createTestDb();
    drop = testDb.drop;
    await initDb(testDb.connectionString);
    app = createApp();
  });

  afterAll(async () => {
    await closeDb();
    await drop();
  });

  it('GET /api/fallback/order returns the live effective order', async () => {
    const { status, body } = await request(app, 'GET', '/api/fallback/order');
    expect(status).toBe(200);
    expect(body).toHaveProperty('taskType', 'overall');
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    // Rows are ordered by effectiveScore, with disabled/no-key sunk to the end.
    const rank = (r: any) => (r.status === 'disabled' || r.status === 'no_key') ? 1 : 0;
    for (let i = 1; i < body.rows.length; i++) {
      const a = body.rows[i - 1], b = body.rows[i];
      if (rank(a) === rank(b)) expect(b.effectiveScore).toBeGreaterThanOrEqual(a.effectiveScore);
      else expect(rank(b)).toBeGreaterThanOrEqual(rank(a));
    }
  });

  it('GET /api/fallback/order rows have the expected breakdown fields', async () => {
    const { body } = await request(app, 'GET', '/api/fallback/order');
    const first = body.rows[0];
    for (const f of ['modelDbId', 'platform', 'modelId', 'displayName', 'intelligenceRank', 'effectiveScore', 'keyCount', 'status']) {
      expect(first).toHaveProperty(f);
    }
    expect(['eligible', 'disabled', 'no_key', 'cooling']).toContain(first.status);
  });

  it('GET /api/fallback/order?taskClass=math re-scores for that task', async () => {
    const { status, body } = await request(app, 'GET', '/api/fallback/order?taskClass=math');
    expect(status).toBe(200);
    expect(body.taskType).toBe('math');
  });

  it('the old order-controlling endpoints are gone (page no longer sets order)', async () => {
    // PUT / and POST /sort were removed by design — the page displays order,
    // it does not control it.
    const put = await request(app, 'PUT', '/api/fallback', []);
    expect(put.status).toBe(404);
    const sort = await request(app, 'POST', '/api/fallback/sort/intelligence');
    expect(sort.status).toBe(404);
  });

  it('GET /api/fallback/token-usage still serves the budget bar', async () => {
    const { status, body } = await request(app, 'GET', '/api/fallback/token-usage');
    expect(status).toBe(200);
    expect(body).toHaveProperty('totalBudget');
    expect(body).toHaveProperty('models');
  });
});
