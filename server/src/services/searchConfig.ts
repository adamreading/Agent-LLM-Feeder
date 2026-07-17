import type pg from 'pg';
import { get, run } from '../db/pgCompat.js';
import { encrypt, decrypt } from '../lib/crypto.js';

// Web-search configuration persisted in the settings table so it's managed from
// the UI (Onboarding + Key Vault "Search Providers" card) instead of hand-edited
// in .env. Search keys are third-party secrets, so they're stored ENCRYPTED (same
// crypto as provider api_keys) under `search_key_<id>`, one row PER provider —
// e.g. an Ollama search key lives in `search_key_ollama`, logged separately from
// any Ollama model-provider key even when the underlying credential is the same.
// The active backend id is a non-secret plaintext setting (`web_search_backend`).
//
// This CATALOG is the single source of truth: the server derives the env-var
// bridge + keyed set from it, and the UI renders its cards from it (returned by
// GET /api/settings/search). Add a provider here + implement its SearchBackend
// in webSearch.ts under the same id — nothing else needs editing.
//
// webSearch.ts reads process.env (WEB_SEARCH_BACKEND + each provider's env var),
// so loadSearchConfigIntoEnv() bridges the DB values into env: at server startup,
// after a UI update (live, no restart), and at CLI-research startup. DB is
// authoritative — a value stored via the UI overrides .env.

export interface SearchProviderMeta {
  id: string;
  name: string;
  keyed: boolean;
  /** process.env var webSearch.ts reads the key from (keyed providers only). */
  envVar?: string;
  /** Where to get a key (shown as a button in the UI). */
  getUrl?: string;
  /** Short free-tier / pricing tag for the card. */
  tier: string;
  /** Example key prefix, shown as the input placeholder. */
  prefix?: string;
  /** One-line description for the card. */
  note: string;
  /** PAID provider — kept OUT of the free even-spread rotation and used only as a
   *  last-resort fallback tier when every free engine is exhausted (searchPool.ts). */
  paid?: boolean;
}

// Commonly-used web-search backends. Each keyed entry must have a matching
// implementation in webSearch.ts (same id). Keyless entries (ddg) need no key.
export const SEARCH_PROVIDER_CATALOG: SearchProviderMeta[] = [
  {
    id: 'tavily', name: 'Tavily', keyed: true, envVar: 'TAVILY_API_KEY',
    getUrl: 'https://tavily.com', tier: 'FREE · 1K SEARCHES / MO', prefix: 'tvly-…',
    note: 'Search + page content in one call, built for LLM research. Reliable primary — keyed, so no IP blocking.',
  },
  {
    id: 'ollama', name: 'Ollama Web Search', keyed: true, envVar: 'OLLAMA_API_KEY',
    getUrl: 'https://ollama.com/settings/keys', tier: 'FREE · HOURLY + WEEKLY CAPS', prefix: 'ollama key',
    note: 'Hosted web_search + web_fetch. A dedicated search key (stored separately from any model key). Reliable, but the free tier throttles hard under a big catalog sweep.',
  },
  {
    id: 'brave', name: 'Brave Search', keyed: true, envVar: 'BRAVE_SEARCH_API_KEY',
    getUrl: 'https://brave.com/search/api/', tier: 'FREE 2K/MO · CARD REQUIRED', prefix: 'BSA…',
    note: 'Independent index (not Google/Bing reseller), privacy-first, stable API. NB: sign-up now requires a credit card even for the free tier (confirmed 2026-07-17) — integration works if you add one.',
  },
  {
    id: 'serper', name: 'Serper', keyed: true, envVar: 'SERPER_API_KEY',
    getUrl: 'https://serper.dev', tier: 'FREE · 2.5K CREDITS', prefix: 'serper key',
    note: 'Fast Google SERP results as JSON. Big one-off free credit grant; good for a full catalog populate.',
  },
  {
    id: 'exa', name: 'Exa', keyed: true, envVar: 'EXA_API_KEY',
    getUrl: 'https://exa.ai', tier: 'FREE TIER', prefix: 'exa key',
    note: 'Neural/semantic search built for AI, returns page text inline. Good for research-style queries.',
  },
  {
    id: 'serpapi', name: 'SerpApi', keyed: true, envVar: 'SERPAPI_API_KEY',
    getUrl: 'https://serpapi.com', tier: 'FREE TIER · SERP', prefix: 'serpapi key',
    note: 'Real Google SERP as JSON (serpapi.com — distinct from Serper). Rich organic results; modest free tier, so good as one lane in the spread, not a sole primary.',
  },
  {
    id: 'tinyfish', name: 'TinyFish', keyed: true, envVar: 'TINYFISH_API_KEY',
    getUrl: 'https://agent.tinyfish.ai', tier: 'FREE · 30 QPM', prefix: 'tinyfish key',
    note: 'Free web search for AI agents (api.search.tinyfish.ai). 30 queries/min, no card — a generous free lane for the spread.',
  },
  {
    id: 'contextwire', name: 'ContextWire', keyed: true, envVar: 'CONTEXTWIRE_API_KEY',
    getUrl: 'https://contextwire.dev', tier: 'FREE 1K/MO · SIGNUPS PAUSED', prefix: 'contextwire key',
    note: 'AI-agent search (contextwire.dev/api/search). 1,000 free queries/mo, no card. NB: sign-ups were paused as of 2026-07-17 — integration is ready for when they reopen.',
  },
  {
    id: 'scavio', name: 'Scavio', keyed: true, envVar: 'SCAVIO_API_KEY',
    getUrl: 'https://dashboard.scavio.dev', tier: 'FREE · 250 / MO', prefix: 'scavio key',
    note: 'Real-time multi-platform search (Google et al). 250 free credits/mo + 50 on signup, no card.',
  },
  {
    id: 'searxng', name: 'SearXNG (self-hosted)', keyed: true, envVar: 'SEARXNG_URL',
    getUrl: 'https://docs.searxng.org/admin/installation.html', tier: 'FREE · SELF-HOSTED · UNLIMITED', prefix: 'https://searxng.example.org',
    note: 'Self-hosted metasearch — aggregates many upstream engines, unlimited + private, no card. The "key" is your instance BASE URL (enable `json` in the instance settings.yml formats). Best durable free lane if you run one.',
  },
  {
    id: 'ddg', name: 'DuckDuckGo', keyed: false,
    tier: 'KEYLESS', prefix: '—',
    note: 'Free, no key. Fine for light use, but DDG IP-blocks sustained scraping — unreliable as a heavy primary from a datacenter/WSL egress.',
  },
  {
    id: 'you', name: 'You.com', keyed: true, envVar: 'YOU_API_KEY', paid: true,
    getUrl: 'https://you.com/platform', tier: 'PAID · $5/1K · LAST-RESORT', prefix: 'you key',
    note: 'Paid LLM-ready web+news search (ydc-index.io). NOT in the free rotation — used only as the last line of defence when every free engine is throttled/failed. Guarded by a per-job ($5) + global spend cap.',
  },
];

const KEY_PREFIX = 'search_key_'; // + provider id
const BACKEND_SETTING = 'web_search_backend'; // legacy single-active (back-compat)
const POOL_SETTING = 'web_search_pool';       // JSON array of activated engine ids

export const SEARCH_PROVIDER_BY_ID: Record<string, SearchProviderMeta> = Object.fromEntries(
  SEARCH_PROVIDER_CATALOG.map((p) => [p.id, p]),
);

/** Is this engine a PAID last-resort provider (kept out of the free rotation)? */
export function isPaidBackend(id: string): boolean {
  return !!SEARCH_PROVIDER_BY_ID[id]?.paid;
}

// Derived from the catalog — do not hand-maintain.
export const SEARCH_BACKENDS: string[] = SEARCH_PROVIDER_CATALOG.map((p) => p.id);
export const KEYED_SEARCH_BACKENDS: Record<string, string> = Object.fromEntries(
  SEARCH_PROVIDER_CATALOG.filter((p) => p.keyed && p.envVar).map((p) => [p.id, p.envVar as string]),
);

export function isKnownBackend(id: string): boolean {
  return SEARCH_BACKENDS.includes(id);
}

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

// The ACTIVATED BANK — the set of engines search load spreads across. Stored as a
// JSON array under `web_search_pool`. Back-compat: if unset, fall back to the legacy
// single active backend (so an install that never opened the new UI keeps working).
export async function getSearchPool(pool: pg.Pool): Promise<string[]> {
  const row = await get<{ value: string }>(pool, `SELECT value FROM settings WHERE key = ?`, [POOL_SETTING]);
  if (row?.value) {
    try {
      const ids = JSON.parse(row.value);
      if (Array.isArray(ids)) return ids.filter((x): x is string => typeof x === 'string' && isKnownBackend(x));
    } catch { /* fall through to legacy */ }
  }
  const single = await getActiveSearchBackend(pool);
  return single && isKnownBackend(single) ? [single] : [];
}

export async function setSearchPool(pool: pg.Pool, ids: string[]): Promise<void> {
  const clean = Array.from(new Set(ids.filter(isKnownBackend)));
  await upsertSetting(pool, POOL_SETTING, JSON.stringify(clean));
}

export async function addToPool(pool: pg.Pool, id: string): Promise<string[]> {
  const cur = await getSearchPool(pool);
  if (!cur.includes(id)) cur.push(id);
  await setSearchPool(pool, cur);
  return cur;
}

export async function removeFromPool(pool: pg.Pool, id: string): Promise<string[]> {
  const cur = (await getSearchPool(pool)).filter((x) => x !== id);
  await setSearchPool(pool, cur);
  return cur;
}

// Bridge DB-stored config into process.env so webSearch.ts uses it. DB wins over
// a pre-existing env value (the UI is the intended management surface). Every
// keyed provider is bridged, so a key added via the UI is live without a restart.
export async function loadSearchConfigIntoEnv(pool: pg.Pool): Promise<void> {
  const backend = await getActiveSearchBackend(pool);
  if (backend) process.env.WEB_SEARCH_BACKEND = backend;
  for (const [id, envVar] of Object.entries(KEYED_SEARCH_BACKENDS)) {
    const key = await getSearchKey(pool, id);
    if (key) process.env[envVar] = key;
  }
}
