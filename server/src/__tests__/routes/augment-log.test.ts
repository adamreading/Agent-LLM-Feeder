import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';

async function get(app: Express, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

// Covers the Adam-approved augment-log column + the paired 4xx-rejection logging.
// Asserts the CONTRACT: the `augmented` flag round-trips through /api/requests,
// a synthetic rejection row is OBSERVABLE via /api/requests, and both the
// rejection (is_probe=true) stays OUT of real-traffic analytics.
describe('Augment logging + 4xx rejection observability', () => {
  let app: Express;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const testDb = await createTestDb();
    drop = testDb.drop;
    await initDb(testDb.connectionString);
    app = createApp();

    // A grounded (augmented) research call + a normal ungrounded call.
    await run(getPool(),
      `INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, session_id, task_class, consumer, is_probe, augmented)
       VALUES ('nvidia', 'mistral-large', 'success', 100, 40, 1200, 'session:aug', 'research', 'aug', false, true)`);
    await run(getPool(),
      `INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, session_id, task_class, consumer, is_probe, augmented)
       VALUES ('groq', 'gpt-oss-120b', 'success', 80, 20, 300, 'session:plain', 'coding', 'aug', false, false)`);
    // A pre-routing 4xx rejection exactly as logRejection writes it: sentinel
    // platform, HTTP status in `status`, reason in model_id/error, is_probe=true.
    await run(getPool(),
      `INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, session_id, consumer, is_probe, augmented)
       VALUES ('rejected', 'invalid_body', '400', 0, 0, 0, 'empty assistant content', 'session:plain', 'aug', true, false)`);
  });

  afterAll(async () => {
    await closeDb();
    await drop();
  });

  it('surfaces the `augmented` flag per row via /api/requests', async () => {
    const { status, body } = await get(app, '/api/requests?consumer=aug');
    expect(status).toBe(200);
    const byModel = Object.fromEntries(body.map((r: any) => [r.served_model, r]));
    expect(byModel['nvidia/mistral-large'].augmented).toBe(true);
    expect(byModel['groq/gpt-oss-120b'].augmented).toBe(false);
  });

  it('makes a 4xx rejection OBSERVABLE in /api/requests (deploy-impact / worker 400s)', async () => {
    const { body } = await get(app, '/api/requests?session_id=session:plain');
    const rejection = body.find((r: any) => r.platform === 'rejected');
    expect(rejection).toBeTruthy();
    expect(rejection.status).toBe('400');
    expect(rejection.model_id).toBe('invalid_body');
    expect(rejection.error).toContain('empty assistant');
    expect(rejection.is_probe).toBe(true);
  });

  it('excludes the synthetic rejection row from real-traffic analytics', async () => {
    const { status, body } = await get(app, '/api/analytics/by-model?range=7d');
    expect(status).toBe(200);
    const platforms = body.map((r: any) => r.platform);
    expect(platforms).not.toContain('rejected');       // is_probe=true → filtered
    expect(platforms).toContain('nvidia');              // real traffic still counted
    expect(platforms).toContain('groq');
  });

  it('restores the rejection row under ?includeProbes=1', async () => {
    const { body } = await get(app, '/api/analytics/by-model?range=7d&includeProbes=1');
    expect(body.map((r: any) => r.platform)).toContain('rejected');
  });
});
