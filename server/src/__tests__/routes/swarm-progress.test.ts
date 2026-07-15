import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { get, run } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';
import { recordProgress, _resetSwarmProgress } from '../../services/swarmProgress.js';

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

// The zero-progress circuit-breaker's proxy wiring (RINGER, 2026-07-15): a swarm
// session that has spun trips a terminal 429 pre-route. We pre-trip the in-memory
// tracker (the unit test covers the streak logic) and assert the proxy rejection.
describe('proxy zero-progress circuit-breaker', () => {
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
    _resetSwarmProgress();
  });

  it('rejects a spun swarm session pre-route with terminal 429 no_progress_loop', async () => {
    // Pre-trip: a real opening round, then 15 consecutive zero-output /
    // tiny-input-growth rounds (the first round's big input delta counts as
    // progress, matching real ramp-up — so prime, then spin).
    recordProgress('ringer', 'spin-ses', 21000, 5);
    for (let i = 0; i < 15; i++) recordProgress('ringer', 'spin-ses', 21000 + i * 29, 0);

    const { status, body } = await request(app, 'POST', '/v1/chat/completions',
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      { 'X-Consumer': 'ringer', 'X-Session-Id': 'spin-ses' });

    expect(status).toBe(429);
    expect(body.error.code).toBe('no_progress_loop');
    expect(body.error.session_id).toBe('spin-ses');
    expect(body.error.streak).toBe(15);

    // Logged as a sentinel rejection row (is_probe → excluded from analytics).
    await new Promise((r) => setTimeout(r, 60));
    const row = await get<{ platform: string; model_id: string; status: string; is_probe: boolean; run_id: string | null }>(getPool(),
      `SELECT platform, model_id, status, is_probe, run_id FROM requests WHERE platform='rejected' AND model_id='no_progress_loop' ORDER BY id DESC LIMIT 1`);
    expect(row?.status).toBe('429');
    expect(row?.is_probe).toBe(true);
  });

  it('does NOT block a healthy swarm session (no spin recorded)', async () => {
    const { body } = await request(app, 'POST', '/v1/chat/completions',
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      { 'X-Consumer': 'ringer', 'X-Session-Id': 'healthy-ses' });
    // Routing fails (no keys) but must NOT be the progress breaker.
    expect(body?.error?.code).not.toBe('no_progress_loop');
  });

  it('does NOT block a non-swarm consumer even if a same-named session spun', async () => {
    recordProgress('fleet', 'x-ses', 21000, 5);
    for (let i = 0; i < 15; i++) recordProgress('fleet', 'x-ses', 21000 + i * 29, 0);
    const { body } = await request(app, 'POST', '/v1/chat/completions',
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      { 'X-Consumer': 'fleet', 'X-Session-Id': 'x-ses' });
    // fleet is not a swarm consumer → breaker is not consulted.
    expect(body?.error?.code).not.toBe('no_progress_loop');
  });
});
