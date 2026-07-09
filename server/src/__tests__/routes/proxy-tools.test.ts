import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run, get } from '../../db/pgCompat.js';
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

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

describe('Proxy tool-calling support', () => {
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
    const pool = getPool();
    await run(pool, 'DELETE FROM api_keys');
    await run(pool, 'DELETE FROM requests');
    await run(pool, 'DELETE FROM model_capabilities');

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_proxy_tool_test',
      label: 'proxy-tools',
    });
    expect(addKey.status).toBe(201);

    // P2/P3: tools is a per-model measured capability, checked against
    // model_capabilities — mark every groq model tools-capable for this
    // test (this file tests passthrough mechanics, not the capability gate
    // itself; that's covered by capability-filtering.test.ts).
    await run(pool, `
      INSERT INTO model_capabilities (model_db_id, capability, supported, source)
      SELECT id, 'tools', true, 'measured' FROM models WHERE platform = 'groq'
    `);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes tools/tool_choice to provider and returns tool_calls', async () => {
    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-tool',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_weather',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Karachi"}',
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      // No `model` → auto-route via fallback chain.
      messages: [{ role: 'user', content: 'What is the weather in Karachi?' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      }],
      tool_choice: 'required',
    });

    expect(status).toBe(200);
    expect(providerBody.tools).toHaveLength(1);
    expect(providerBody.tool_choice).toBe('required');
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
  });

  it('accepts assistant tool_calls + tool messages in follow-up turns', async () => {
    const origFetch = global.fetch;
    let providerBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        providerBody = JSON.parse((init as any).body);
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-final',
            object: 'chat.completion',
            created: 123,
            model: 'openai/gpt-oss-120b',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: 'It is 30C in Karachi.',
              },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [
        { role: 'user', content: 'Weather in Karachi?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_weather_1',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"city":"Karachi"}',
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_weather_1',
          content: '{"temp_c":30}',
        },
      ],
    });

    expect(status).toBe(200);
    expect(providerBody.messages[1].role).toBe('assistant');
    expect(providerBody.messages[1].content).toBeNull();
    expect(providerBody.messages[1].tool_calls).toHaveLength(1);
    expect(providerBody.messages[2].role).toBe('tool');
    expect(providerBody.messages[2].tool_call_id).toBe('call_weather_1');
    expect(body.choices[0].message.content).toContain('30C');
  });

  it('L9: falls back on a live tool-capability regression and marks it suspect', async () => {
    const pool = getPool();
    // Narrow eligibility to exactly two models so the fallback sequence
    // is deterministic (order-independent assertions below cover whichever
    // of the two the router tries first).
    await run(pool, `DELETE FROM model_capabilities`);
    await run(pool, `
      INSERT INTO model_capabilities (model_db_id, capability, supported, source)
      SELECT id, 'tools', true, 'measured' FROM models
      WHERE platform = 'groq' AND model_id IN ('openai/gpt-oss-120b', 'llama-3.3-70b-versatile')
    `);
    // Routing now orders by intelligence_rank; force llama to lead so it's the
    // one that hits the (mocked) tool-capability regression and triggers the
    // L9 fallback + suspect-marking this test asserts on.
    await run(pool, `UPDATE models SET intelligence_rank = 1 WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-versatile'`);
    await run(pool, `UPDATE models SET intelligence_rank = 5 WHERE platform = 'groq' AND model_id = 'openai/gpt-oss-120b'`);

    const origFetch = global.fetch;
    const calledModels: string[] = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com/openai/v1/chat/completions')) {
        const reqBody = JSON.parse((init as any).body);
        calledModels.push(reqBody.model);
        if (reqBody.model === 'llama-3.3-70b-versatile') {
          return {
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: () => Promise.resolve({ error: { message: '`tool calling` is not supported with this model' } }),
          } as any;
        }
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-fallback',
            object: 'chat.completion',
            created: 123,
            model: reqBody.model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Lagos"}' } }] },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Weather in Lagos?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
      tool_choice: 'required',
    });

    expect(status).toBe(200);
    expect(calledModels).toContain('openai/gpt-oss-120b');
    expect(calledModels).toContain('llama-3.3-70b-versatile');
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');

    const suspectRow = await get<{ suspect: boolean }>(pool, `
      SELECT mc.suspect FROM model_capabilities mc
      JOIN models m ON m.id = mc.model_db_id
      WHERE m.platform = 'groq' AND m.model_id = 'llama-3.3-70b-versatile' AND mc.capability = 'tools'
    `);
    expect(suspectRow?.suspect).toBe(true);
  });
});
