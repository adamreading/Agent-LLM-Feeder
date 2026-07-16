import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';
import {
  SEARCH_BACKENDS, KEYED_SEARCH_BACKENDS,
  getSearchKey, setSearchKey, loadSearchConfigIntoEnv,
} from '../../services/searchConfig.js';

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

describe('Search provider config', () => {
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
    await run(getPool(), `DELETE FROM settings WHERE key LIKE 'search_key_%' OR key = 'web_search_backend'`);
    delete process.env.OLLAMA_API_KEY;
    delete process.env.WEB_SEARCH_BACKEND;
  });

  it('catalog exposes ollama as a KEYED backend mapped to OLLAMA_API_KEY', () => {
    // The core of the fix: ollama search is a first-class keyed backend, not
    // "keyless" and not piggybacking a model key.
    expect(SEARCH_BACKENDS).toEqual(expect.arrayContaining(['tavily', 'ollama', 'brave', 'serper', 'exa', 'ddg']));
    expect(KEYED_SEARCH_BACKENDS.ollama).toBe('OLLAMA_API_KEY');
    expect(KEYED_SEARCH_BACKENDS.brave).toBe('BRAVE_SEARCH_API_KEY');
    expect(KEYED_SEARCH_BACKENDS.ddg).toBeUndefined(); // keyless
  });

  it('GET /api/settings/search returns the provider catalog with per-provider key state', async () => {
    const { status, body } = await request(app, 'GET', '/api/settings/search');
    expect(status).toBe(200);
    const ollama = body.providers.find((p: any) => p.id === 'ollama');
    expect(ollama).toBeDefined();
    expect(ollama.keyed).toBe(true);
    expect(ollama.keySet).toBe(false);
    const ddg = body.providers.find((p: any) => p.id === 'ddg');
    expect(ddg.keyed).toBe(false);
  });

  it('POST setKey stores a per-provider key, activates it, and never returns the full key', async () => {
    const { status, body } = await request(app, 'POST', '/api/settings/search', {
      setKey: { backend: 'ollama', key: 'super-secret-ollama-key-value' },
    });
    expect(status).toBe(200);
    expect(body.backend).toBe('ollama'); // pasting a key activates it
    const ollama = body.providers.find((p: any) => p.id === 'ollama');
    expect(ollama.keySet).toBe(true);
    expect(ollama.keyMasked).not.toContain('super-secret-ollama-key-value');
    // stored under its OWN settings row, encrypted, round-trips
    expect(await getSearchKey(getPool(), 'ollama')).toBe('super-secret-ollama-key-value');
  });

  it('loadSearchConfigIntoEnv bridges the ollama search key to OLLAMA_API_KEY', async () => {
    await setSearchKey(getPool(), 'ollama', 'bridged-key-123');
    expect(process.env.OLLAMA_API_KEY).toBeUndefined();
    await loadSearchConfigIntoEnv(getPool());
    expect(process.env.OLLAMA_API_KEY).toBe('bridged-key-123');
  });

  it('refuses to activate a keyed backend with no key (400)', async () => {
    const { status } = await request(app, 'POST', '/api/settings/search', { activate: 'brave' });
    expect(status).toBe(400);
  });

  it('activates a keyless backend (ddg) without a key', async () => {
    const { status, body } = await request(app, 'POST', '/api/settings/search', { activate: 'ddg' });
    expect(status).toBe(200);
    expect(body.backend).toBe('ddg');
  });

  it('clearKey purges the stored key', async () => {
    await request(app, 'POST', '/api/settings/search', { setKey: { backend: 'tavily', key: 'tvly-abc' } });
    const { body } = await request(app, 'POST', '/api/settings/search', { clearKey: 'tavily' });
    const tavily = body.providers.find((p: any) => p.id === 'tavily');
    expect(tavily.keySet).toBe(false);
    expect(await getSearchKey(getPool(), 'tavily')).toBeNull();
  });

  it('rejects an unknown backend id', async () => {
    const { status } = await request(app, 'POST', '/api/settings/search', { activate: 'not-a-real-engine' });
    expect(status).toBe(400);
  });

  it('verify returns ok:false with a reason when a keyed backend has no key (no network)', async () => {
    const { status, body } = await request(app, 'POST', '/api/settings/search/verify', { backend: 'brave' });
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/no key/i);
  });

  it('verify rejects an unknown backend (400)', async () => {
    const { status } = await request(app, 'POST', '/api/settings/search/verify', { backend: 'nope' });
    expect(status).toBe(400);
  });
});
