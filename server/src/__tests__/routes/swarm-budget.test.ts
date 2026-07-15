import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { get, run } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';
import { _resetSwarmBudget } from '../../services/swarmBudget.js';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

// RINGER swarm per-run spend cap (2026-07-15): the POST /api/swarm/budget
// declare endpoint + the pre-route enforcer + X-Run-Id logging (the joint
// wire-probe). All localhost, so the test's own 127.0.0.1 calls are trusted.
describe('POST /api/swarm/budget + X-Run-Id enforcer', () => {
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

  beforeEach(async () => {
    await run(getPool(), 'DELETE FROM requests');
    _resetSwarmBudget();
  });

  it('declares a budget, echoing seeded spend from the log', async () => {
    await run(getPool(), `INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, consumer, run_id, is_probe)
      VALUES ('groq','m','success',40,10,'ringer','R-seed',false)`);
    const { status, body } = await request(app, 'POST', '/api/swarm/budget', { run_id: 'R-seed', max_tokens: 500000 });
    expect(status).toBe(200);
    expect(body).toMatchObject({ run_id: 'R-seed', consumer: 'ringer', budget: 500000, spent: 50 });
  });

  it('rejects a declare missing run_id / max_tokens', async () => {
    expect((await request(app, 'POST', '/api/swarm/budget', { max_tokens: 100 })).status).toBe(400);
    expect((await request(app, 'POST', '/api/swarm/budget', { run_id: 'x', max_tokens: 0 })).status).toBe(400);
    expect((await request(app, 'POST', '/api/swarm/budget', { run_id: 'x', max_tokens: -5 })).status).toBe(400);
  });

  it('ENFORCES: an over-budget run gets a terminal 429 run_budget_exceeded pre-route', async () => {
    // Seed 100 tokens of real spend for the run, then declare a ceiling of 10.
    await run(getPool(), `INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, consumer, run_id, is_probe)
      VALUES ('groq','m','success',60,40,'ringer','R-over',false)`);
    const declare = await request(app, 'POST', '/api/swarm/budget', { run_id: 'R-over', max_tokens: 10 });
    expect(declare.body).toMatchObject({ budget: 10, spent: 100 });

    // A /v1 call for this run is refused BEFORE routing — no provider needed.
    const { status, body } = await request(app, 'POST', '/v1/chat/completions',
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      { 'X-Consumer': 'ringer', 'X-Run-Id': 'R-over', 'X-Session-Id': 'ses-1' });
    expect(status).toBe(429);
    expect(body.error.code).toBe('run_budget_exceeded');
    expect(body.error.run_id).toBe('R-over');
    expect(body.error.spent).toBe(100);
    expect(body.error.budget).toBe(10);

    // The terminal rejection is logged (sentinel platform='rejected', is_probe, run_id carried).
    await new Promise((r) => setTimeout(r, 60));
    const row = await get<{ platform: string; run_id: string; is_probe: boolean; status: string }>(getPool(),
      `SELECT platform, run_id, is_probe, status FROM requests WHERE run_id = 'R-over' AND platform = 'rejected' ORDER BY id DESC LIMIT 1`);
    expect(row).toBeTruthy();
    expect(row!.status).toBe('429');
    expect(row!.is_probe).toBe(true);
  });

  it('is OPT-IN: a run with NO declared budget is NOT blocked (no run_budget_exceeded)', async () => {
    const { body } = await request(app, 'POST', '/v1/chat/completions',
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      { 'X-Consumer': 'ringer', 'X-Run-Id': 'R-undeclared', 'X-Session-Id': 'ses-2' });
    // With no provider keys the routing fails, but it must NOT be the budget gate.
    expect(body?.error?.code).not.toBe('run_budget_exceeded');
  });

  it('GET /api/swarm/budget reports live state, 404 for an undeclared run', async () => {
    await request(app, 'POST', '/api/swarm/budget', { run_id: 'R-get', max_tokens: 1234 });
    const found = await request(app, 'GET', '/api/swarm/budget?run_id=R-get');
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ run_id: 'R-get', consumer: 'ringer', budget: 1234 });
    expect((await request(app, 'GET', '/api/swarm/budget?run_id=nope')).status).toBe(404);
  });
});
