import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';

async function request(app: Express, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Requests telemetry API (/api/requests)', () => {
  let app: Express;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const testDb = await createTestDb();
    drop = testDb.drop;
    await initDb(testDb.connectionString);
    app = createApp();

    // Two workers of one swarm consumer (worker A had a failover), one other consumer.
    const ins = (platform: string, model: string, status: string, sid: string, consumer: string, err: string | null = null) =>
      run(getPool(),
        `INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, session_id, task_class, consumer, is_probe) VALUES (?, ?, ?, 100, 5, 1000, ?, ?, 'coding', ?, false)`,
        [platform, model, status, err, sid, consumer]);
    await ins('sambanova', 'DeepSeek-V3.1', 'success', 'session:w-a', 'ringer-test');
    await ins('sambanova', 'DeepSeek-V3.1', 'error', 'session:w-a', 'ringer-test', 'SambaNova API error 429');
    await ins('nvidia', 'mistral-large', 'success', 'session:w-a', 'ringer-test');
    await ins('groq', 'llama-3.3-70b', 'success', 'session:w-b', 'ringer-test');
    await ins('cerebras', 'gpt-oss-120b', 'success', 'session:other', 'hermes');
  });

  afterAll(async () => {
    await closeDb();
    await drop();
  });

  it('filters by consumer and stamps served_model, in chronological order', async () => {
    const { status, body } = await request(app, '/api/requests?consumer=ringer-test');
    expect(status).toBe(200);
    expect(body.length).toBe(4); // 3 for w-a + 1 for w-b, not the hermes row
    expect(body.every((r: any) => r.consumer === 'ringer-test')).toBe(true);
    expect(body[0].served_model).toBe('sambanova/DeepSeek-V3.1');
    // chronological: ascending id
    const ids = body.map((r: any) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('filters by session_id — surfaces a worker\'s call sequence incl. the failover', async () => {
    const { body } = await request(app, '/api/requests?session_id=session:w-a');
    expect(body.length).toBe(3);
    expect(body.map((r: any) => `${r.served_model}:${r.status}`)).toEqual([
      'sambanova/DeepSeek-V3.1:success',
      'sambanova/DeepSeek-V3.1:error',
      'nvidia/mistral-large:success',
    ]);
    expect(body[1].error).toContain('429');
  });

  it('projects run_id and filters by it (the field ringer surfaces on the wall)', async () => {
    // A swarm run's worker rows carry run_id (X-Run-Id). Seed two with a run id.
    await run(getPool(),
      `INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, session_id, consumer, run_id, is_probe) VALUES
       ('groq','m','success',10,5,100,'session:w-r','ringer-test','run-XYZ',false),
       ('nvidia','m','success',10,5,100,'session:w-r','ringer-test','run-XYZ',false)`);
    const { status, body } = await request(app, '/api/requests?run_id=run-XYZ');
    expect(status).toBe(200);
    expect(body.length).toBe(2);
    expect(body.every((r: any) => r.run_id === 'run-XYZ')).toBe(true); // projected, not null
  });

  it('rejects a malformed since with 400', async () => {
    const { status } = await request(app, '/api/requests?since=not-a-date');
    expect(status).toBe(400);
  });

  it('accepts an ISO since and limit', async () => {
    const { status, body } = await request(app, '/api/requests?consumer=ringer-test&since=2000-01-01T00:00:00Z&limit=2');
    expect(status).toBe(200);
    expect(body.length).toBe(2);
  });
});
