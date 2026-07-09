import type pg from 'pg';
import { get, run } from '../db/pgCompat.js';
import { encrypt, decrypt } from '../lib/crypto.js';

// Web-search configuration persisted in the settings table so it's managed from
// the UI (the onboarding "Search Key" card) instead of hand-edited in .env.
// Search keys are third-party secrets, so they're stored ENCRYPTED (same
// crypto as provider api_keys), unlike the plaintext unified key. The active
// backend id is a non-secret plaintext setting.
//
// webSearch.ts reads process.env (WEB_SEARCH_BACKEND / TAVILY_API_KEY), so
// loadSearchConfigIntoEnv() bridges the DB values into env: called at server
// startup, after a UI update (live, no restart), and at CLI-research startup.
// DB is authoritative — a value stored via the UI overrides .env.

const KEY_PREFIX = 'search_key_'; // + backend id
const BACKEND_SETTING = 'web_search_backend';

// Backends that take an API key, mapped to the env var webSearch.ts reads.
export const KEYED_SEARCH_BACKENDS: Record<string, string> = { tavily: 'TAVILY_API_KEY' };
export const SEARCH_BACKENDS = ['ollama', 'ddg', 'tavily'];

async function upsertSetting(pool: pg.Pool, key: string, value: string): Promise<void> {
  await run(pool, `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}

export async function setSearchKey(pool: pg.Pool, backend: string, key: string): Promise<void> {
  const { encrypted, iv, authTag } = encrypt(key);
  await upsertSetting(pool, KEY_PREFIX + backend, JSON.stringify({ encrypted, iv, authTag }));
}

export async function getSearchKey(pool: pg.Pool, backend: string): Promise<string | null> {
  const row = await get<{ value: string }>(pool, `SELECT value FROM settings WHERE key = ?`, [KEY_PREFIX + backend]);
  if (!row) return null;
  try {
    const p = JSON.parse(row.value) as { encrypted: string; iv: string; authTag: string };
    return decrypt(p.encrypted, p.iv, p.authTag);
  } catch {
    return null;
  }
}

export async function clearSearchKey(pool: pg.Pool, backend: string): Promise<void> {
  await run(pool, `DELETE FROM settings WHERE key = ?`, [KEY_PREFIX + backend]);
}

export async function setActiveSearchBackend(pool: pg.Pool, id: string): Promise<void> {
  await upsertSetting(pool, BACKEND_SETTING, id);
}

export async function getActiveSearchBackend(pool: pg.Pool): Promise<string | null> {
  const row = await get<{ value: string }>(pool, `SELECT value FROM settings WHERE key = ?`, [BACKEND_SETTING]);
  return row?.value ?? null;
}

// Bridge DB-stored config into process.env so webSearch.ts uses it. DB wins over
// a pre-existing env value (the UI is the intended management surface).
export async function loadSearchConfigIntoEnv(pool: pg.Pool): Promise<void> {
  const backend = await getActiveSearchBackend(pool);
  if (backend) process.env.WEB_SEARCH_BACKEND = backend;
  for (const [id, envVar] of Object.entries(KEYED_SEARCH_BACKENDS)) {
    const key = await getSearchKey(pool, id);
    if (key) process.env[envVar] = key;
  }
}
