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

// Found live 2026-07-08 (wsl-claude, prepping the privileged_write probe run):
// the catalog seeds a bare model_id that collides across platforms (e.g.
// gpt-oss-120b exists on both cerebras and sambanova) — these are NOT
// interchangeable instances, they differ on tool support, json_mode dialect,
// and rate limits. Before this fix, a pin on the bare id silently resolved
// to whichever row Postgres happened to return first for that model_id —
// violating Lunk's "pinned must mean truly pinned" condition. This describes
// the fix: fail closed on ambiguity, and support an explicit platform/model_id
// compound pin to disambiguate.
describe('Model pin disambiguation (platform/model_id collisions)', () => {
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

  it('fails closed with a typed 400 on a bare model_id that collides across platforms, naming every colliding platform', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'gpt-oss-120b', // seeded on both cerebras and sambanova
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_ambiguous');
    expect(body.error.message).toContain('cerebras');
    expect(body.error.message).toContain('sambanova');
  });

  it('an unambiguous platform/model_id compound pin is not rejected as ambiguous or unknown', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'sambanova/gpt-oss-120b',
      messages: [{ role: 'user', content: 'hi' }],
    });

    // No key configured for sambanova yet — expect a routing error (no
    // eligible model), NOT a pin-resolution error. Proves the compound form
    // was parsed and matched a real row rather than falling through to
    // "not in the catalog".
    expect(status).not.toBe(400);
    expect([422, 429, 502, 503]).toContain(status);
  });

  it('compound pin targets the EXACT platform instance, never the other colliding row', async () => {
    await request(app, 'POST', '/api/keys', { platform: 'sambanova', key: 'test-sambanova-key' });
    // Deliberately no cerebras key — if the pin fell through to the wrong
    // (cerebras) row, this would fail with a routing error instead of 200.

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.sambanova.ai')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-pin-test',
            object: 'chat.completion',
            created: 123,
            model: 'gpt-oss-120b',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'sambanova/gpt-oss-120b',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('ok');
  });

  it('a genuinely unknown platform/model_id compound still returns model_not_found, not a false ambiguity error', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'not-a-real-platform/not-a-real-model',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(status).toBe(400);
    expect(body.error.code).toBe('model_not_found');
  });
});
