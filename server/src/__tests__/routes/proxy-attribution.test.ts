import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { get, run } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';

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

// wsl's multi-consumer attribution request (2026-07-08): after the main-brain
// flip, the request log mixed eligible-pool models (Lunk, needs-filtered)
// with non-eligible ones (a different consumer sending agentic_chat WITHOUT
// needs), and there was no way to tell them apart from the row. These prove
// the fix: every request row now records WHO called (consumer) and WHAT
// needs filter was applied — so "Lunk's needs-filtering is 100%" and "who is
// the other consumer" are both answerable from the log alone.
describe('Request attribution: consumer + needs logged per row', () => {
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
    await run(getPool(), 'DELETE FROM api_keys');
    await run(getPool(), 'DELETE FROM requests');
    await run(getPool(), 'DELETE FROM model_capabilities');
  });

  afterEach(() => vi.restoreAllMocks());

  function mockGroqOk() {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'x', object: 'chat.completion', created: 1, model: 'test',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });
  }

  it('logs consumer=local for a tokenless localhost call, and the needs it filtered on', async () => {
    await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'test-groq-key' });
    await run(getPool(), `INSERT INTO model_capabilities (model_db_id, capability, supported, source) SELECT id, 'tools', true, 'measured' FROM models WHERE platform = 'groq'`);
    mockGroqOk();

    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto/agentic_chat',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }],
      needs: ['tools'],
    });
    expect(status).toBe(200);

    await new Promise((r) => setTimeout(r, 60)); // logRequest is fire-and-forget
    const row = await get<{ consumer: string; needs: string; task_class: string }>(getPool(), `SELECT consumer, needs, task_class FROM requests WHERE is_probe = false ORDER BY id DESC LIMIT 1`);
    expect(row!.consumer).toBe('local');
    expect(row!.needs).toContain('tools');
    expect(row!.task_class).toBe('agentic_chat');
  });

  it('a generic call with no needs logs an empty needs column — the empirical "ran unfiltered" signal', async () => {
    await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'test-groq-key' });
    mockGroqOk();

    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(status).toBe(200);

    await new Promise((r) => setTimeout(r, 60));
    const row = await get<{ consumer: string; needs: string | null }>(getPool(), `SELECT consumer, needs FROM requests WHERE is_probe = false ORDER BY id DESC LIMIT 1`);
    expect(row!.consumer).toBe('local');
    expect(row!.needs).toBeNull(); // no needs filter applied — distinguishable from a needs-carrying call
  });

  it('distinguishes a named fleet consumer key from an unknown/unauthenticated caller', async () => {
    // Register a fleet consumer key with a recognizable label.
    const { createHash } = await import('crypto');
    const token = 'lunk-test-token';
    const hash = createHash('sha256').update(token).digest('hex');
    await run(getPool(), `INSERT INTO consumer_keys (label, key_hash, trust_tier, enabled) VALUES ('lunk-fleet', ?, 'fleet', true)`, [hash]);
    await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'test-groq-key' });
    mockGroqOk();

    // Call from a NON-local address is simulated by presenting the token;
    // the label should be recorded regardless. (Local short-circuits to
    // 'local' only when NO token is presented — a token is always resolved.)
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, { Authorization: `Bearer ${token}` });
    expect(status).toBe(200);

    await new Promise((r) => setTimeout(r, 60));
    const row = await get<{ consumer: string }>(getPool(), `SELECT consumer FROM requests WHERE is_probe = false ORDER BY id DESC LIMIT 1`);
    expect(row!.consumer).toBe('lunk-fleet');
  });
});
