import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { get, run } from '../../db/pgCompat.js';
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

describe('Model canon API (/api/canon)', () => {
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

  it('GET / lists canonical models with linked instances and a capability rollup, matching the wiki\'s data contract', async () => {
    const { status, body } = await request(app, 'GET', '/api/canon');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    const gptOss = body.find((c: any) => c.instances.some((i: any) => i.model_id === 'gpt-oss-120b'));
    expect(gptOss).toBeDefined();
    expect(gptOss.instances.length).toBeGreaterThanOrEqual(2);
    expect(gptOss.instances.map((i: any) => i.platform)).toEqual(expect.arrayContaining(['cerebras', 'sambanova']));
  });

  it('GET /unmatched lists supplier rows that have not completed matching — the wiki must not show these', async () => {
    const { status, body } = await request(app, 'GET', '/api/canon/unmatched');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // None of the unmatched rows should already carry a canonical link.
    const pool = getPool();
    for (const row of body.slice(0, 5)) {
      const dbRow = await get<{ canonical_model_id: number | null }>(pool, 'SELECT canonical_model_id FROM models WHERE id = ?', [row.id]);
      expect(dbRow!.canonical_model_id).toBeNull();
    }
  });

  it('POST / creates a new canonical model from an unmatched row, and it disappears from /unmatched and appears in /', async () => {
    const { body: unmatched } = await request(app, 'GET', '/api/canon/unmatched');
    const target = unmatched[0];

    const { status, body: created } = await request(app, 'POST', '/api/canon', {
      model_db_id: target.id,
      name: 'Test Canonical Model',
      summary: 'A test paragraph.',
    });
    expect(status).toBe(201);
    expect(created.canonical_model_id).toBeDefined();

    const { body: afterUnmatched } = await request(app, 'GET', '/api/canon/unmatched');
    expect(afterUnmatched.find((r: any) => r.id === target.id)).toBeUndefined();

    const { body: canon } = await request(app, 'GET', '/api/canon');
    const created2 = canon.find((c: any) => c.id === created.canonical_model_id);
    expect(created2).toBeDefined();
    expect(created2.summary).toBe('A test paragraph.');
    expect(created2.instances.some((i: any) => i.id === target.id)).toBe(true);
  });

  it('POST /match links an unmatched row to an existing canonical model', async () => {
    const { body: unmatched } = await request(app, 'GET', '/api/canon/unmatched');
    const target = unmatched[0];
    const { body: canon } = await request(app, 'GET', '/api/canon');
    const existing = canon[0];

    const { status } = await request(app, 'POST', '/api/canon/match', {
      model_db_id: target.id,
      canonical_model_id: existing.id,
    });
    expect(status).toBe(200);

    const pool = getPool();
    const row = await get<{ canonical_model_id: number; match_status: string }>(pool, 'SELECT canonical_model_id, match_status FROM models WHERE id = ?', [target.id]);
    expect(row!.canonical_model_id).toBe(existing.id);
    expect(row!.match_status).toBe('manual_matched');
  });

  it('POST /match with an unknown canonical_model_id returns 404, not a silent no-op', async () => {
    const { body: unmatched } = await request(app, 'GET', '/api/canon/unmatched');
    const target = unmatched[unmatched.length - 1];

    const { status } = await request(app, 'POST', '/api/canon/match', {
      model_db_id: target.id,
      canonical_model_id: 999999,
    });
    expect(status).toBe(404);
  });

  it('POST /run-match is idempotent when called again with nothing new to merge', async () => {
    await run(getPool(), `UPDATE models SET canonical_model_id = NULL, match_status = 'unmatched'`);
    await run(getPool(), `DELETE FROM canonical_model_aliases`);
    await run(getPool(), `DELETE FROM canonical_models`);

    const { status, body: first } = await request(app, 'POST', '/api/canon/run-match');
    expect(status).toBe(200);
    expect(first.autoMergedGroups).toBeGreaterThan(0);

    const { body: second } = await request(app, 'POST', '/api/canon/run-match');
    expect(second.autoMergedGroups).toBe(0);
    expect(second.autoLinkedToExisting).toBe(0);
    expect(second.stillUnmatched).toBe(first.stillUnmatched);
  });

  it('PATCH /:id updates a canonical model\'s wiki content', async () => {
    const { body: canon } = await request(app, 'GET', '/api/canon');
    const target = canon[0];

    const { status } = await request(app, 'PATCH', `/api/canon/${target.id}`, {
      summary: 'Updated wiki paragraph.',
      vision: true,
    });
    expect(status).toBe(200);

    const { body: after } = await request(app, 'GET', '/api/canon');
    const updated = after.find((c: any) => c.id === target.id);
    expect(updated.summary).toBe('Updated wiki paragraph.');
    expect(updated.vision).toBe(true);
  });

  it('GET /task-types returns the lmarena-category taxonomy', async () => {
    const { status, body } = await request(app, 'GET', '/api/canon/task-types');
    expect(status).toBe(200);
    expect(body).toEqual(expect.arrayContaining(['overall', 'coding', 'creative_writing']));
  });

  it('POST /:id/scores records a quality score that then surfaces in GET / and GET /:id/scores', async () => {
    const { body: canon } = await request(app, 'GET', '/api/canon');
    const target = canon[0];

    const { status } = await request(app, 'POST', `/api/canon/${target.id}/scores`, {
      task_type: 'coding',
      score: 0.82,
      rank: 5,
      evidence: 'lmarena',
    });
    expect(status).toBe(201);

    const { body: scores } = await request(app, 'GET', `/api/canon/${target.id}/scores`);
    const coding = scores.find((s: any) => s.task_type === 'coding');
    expect(coding.score).toBeCloseTo(0.82);
    expect(coding.source).toBe('benchmark');

    const { body: after } = await request(app, 'GET', '/api/canon');
    const updated = after.find((c: any) => c.id === target.id);
    expect(updated.taskScores.some((s: any) => s.task_type === 'coding' && Math.abs(s.score - 0.82) < 1e-6)).toBe(true);
  });

  it('POST /:id/scores rejects an out-of-range score (must be 0-1)', async () => {
    const { body: canon } = await request(app, 'GET', '/api/canon');
    const { status } = await request(app, 'POST', `/api/canon/${canon[0].id}/scores`, { task_type: 'coding', score: 42 });
    expect(status).toBe(400);
  });

  it('POST /:id/scores on an unknown canonical id returns 404', async () => {
    const { status } = await request(app, 'POST', '/api/canon/999999/scores', { task_type: 'coding', score: 0.5 });
    expect(status).toBe(404);
  });
});
