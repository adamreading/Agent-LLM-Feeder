import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run } from '../../db/pgCompat.js';
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

// P2 DoD: "a json_mode request to a non-json-capable model is provably
// rerouted or cleanly refused, shown live" — this is that demonstration,
// end-to-end over real HTTP against the real proxy endpoint.
describe('P2 DoD: response_format capability gate, live over HTTP', () => {
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cleanly refuses (typed 422, not a silent send) when only a non-json-capable provider has a key', async () => {
    const { status: keyStatus } = await request(app, 'POST', '/api/keys', {
      platform: 'kilo', // no jsonMode dialect declared (P2)
      key: 'test-kilo-key',
    });
    expect(keyStatus).toBe(201);

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'return {"ok":true} as json' }],
      response_format: { type: 'json_object' },
    });

    expect(status).toBe(422);
    expect(body.error.code).toBe('NO_ELIGIBLE_MODEL');
    expect(body.error.type).toBe('routing_error');
  });

  it('routes to a json_mode-capable provider when both a capable and incapable key exist — never sends it to Kilo', async () => {
    await request(app, 'POST', '/api/keys', { platform: 'kilo', key: 'test-kilo-key' });
    await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'test-groq-key' });

    let calledUrl: string | null = null;
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        calledUrl = urlStr;
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-cap-test',
            object: 'chat.completion',
            created: 123,
            model: 'test-model',
            choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'return {"ok":true} as json' }],
      response_format: { type: 'json_object' },
    });

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('{"ok":true}');
    expect(calledUrl).toContain('api.groq.com');
    expect(calledUrl).not.toContain('kilo');
  });
});

// wsl-claude pre-wire catch, 2026-07-08: a live 10x test of auto/agentic_chat
// (Lunk's real main-brain task_class) showed 40% of turns landing on models
// with unmeasured ob_readwrite data — tools was gated, ob_readwrite was not,
// because "needs OB access" isn't a request-body field the way tools[] is;
// it has to be derived from the task_class sentinel itself. This is that
// enforcement, demonstrated live over HTTP with no explicit `needs` param.
describe('auto/agentic_chat sentinel enforces ob_readwrite, live over HTTP', () => {
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
    await run(getPool(), 'DELETE FROM model_capabilities');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses with 422 when the only key is on a tools-confirmed but ob_readwrite-unmeasured model', async () => {
    await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'test-groq-key' });
    await run(getPool(), `
      INSERT INTO model_capabilities (model_db_id, capability, supported, source)
      SELECT id, 'tools', true, 'measured' FROM models WHERE platform = 'groq'
    `);
    // Deliberately no ob_readwrite rows at all — exactly the live gap found.

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto/agentic_chat',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }],
    });

    expect(status).toBe(422);
    expect(body.error.code).toBe('NO_ELIGIBLE_MODEL');
  });

  it('routes only to the model confirmed for BOTH tools and ob_readwrite', async () => {
    await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'test-groq-key' });
    await run(getPool(), `
      INSERT INTO model_capabilities (model_db_id, capability, supported, source)
      SELECT id, 'tools', true, 'measured' FROM models WHERE platform = 'groq'
    `);
    const pool = getPool();
    const eligible = await import('../../db/pgCompat.js').then((m) => m.get<{ id: number }>(pool, `SELECT id FROM models WHERE platform = 'groq' LIMIT 1`));
    await run(pool, `INSERT INTO model_capabilities (model_db_id, capability, supported, source) VALUES (?, 'ob_readwrite', true, 'measured')`, [eligible!.id]);

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-agentic',
            object: 'chat.completion',
            created: 123,
            model: 'test-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok', tool_calls: null }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'auto/agentic_chat',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }],
    });

    expect(status).toBe(200);
  });
});
