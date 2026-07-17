import type pg from 'pg';
import { all } from '../db/pgCompat.js';
import { decrypt } from '../lib/crypto.js';

// Authoritative model-list discovery: hit every enabled provider key's live
// GET /models endpoint and return the model-id list the key can actually see.
// GET-only — NO completion tokens are ever spent here (honours Adam's no-probe-
// sweep rule; discovery is free, only liveness/research downstream cost tokens).
//
// Extracted 2026-07-17 from scripts/discover-models.ts so both the manual
// reporter AND the daily catalogSync reconciler share one source of truth for
// the endpoint map + response-shape parsing. discover-models.ts stays a thin
// CLI wrapper that dumps this to a file; catalogSync consumes it directly.

interface KeyRow { platform: string; encrypted_key: string; iv: string; auth_tag: string; status: string }

export interface PlatformDiscovery {
  status: number;        // HTTP status (0 = network error, -1 decrypt fail, -2 no endpoint mapping)
  ids: string[];         // live model ids the key can see
  err?: string;
}
export type DiscoveryResult = Record<string, PlatformDiscovery>;

// A poll is trustworthy enough to drive retirement ONLY if it clearly succeeded
// with a non-empty list. Anything else (4xx/5xx, network error, empty list,
// no-mapping) must NEVER retire a model — it's indistinguishable from "we just
// couldn't see the list this time".
export function isTrustworthyPoll(d: PlatformDiscovery): boolean {
  return d.status === 200 && d.ids.length > 0;
}

// baseUrls mirror providers/index.ts (duplicated intentionally — a low-coupling
// discovery concern, same as the original one-shot tool).
const OPENAI_COMPAT: Record<string, { url: string; headers?: Record<string, string> }> = {
  groq: { url: 'https://api.groq.com/openai/v1/models' },
  cerebras: { url: 'https://api.cerebras.ai/v1/models' },
  sambanova: { url: 'https://api.sambanova.ai/v1/models' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/models' },
  mistral: { url: 'https://api.mistral.ai/v1/models' },
  openrouter: { url: 'https://openrouter.ai/api/v1/models', headers: { 'HTTP-Referer': 'http://localhost:3001', 'X-Title': 'FreeLLMAPI' } },
  github: { url: 'https://models.github.ai/catalog/models' },
  zhipu: { url: 'https://open.bigmodel.cn/api/paas/v4/models' },
  ollama: { url: 'https://ollama.com/v1/models' },
  kilo: { url: 'https://api.kilo.ai/api/gateway/v1/models' },
  pollinations: { url: 'https://text.pollinations.ai/openai/v1/models' },
  llm7: { url: 'https://api.llm7.io/v1/models' },
  opencode: { url: 'https://opencode.ai/zen/v1/models' },
  cohere: { url: 'https://api.cohere.ai/compatibility/v1/models' },
};

async function fetchJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: any; err?: string }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(t);
    let body: any = null;
    const text = await res.text();
    try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    return { status: res.status, body };
  } catch (e: any) {
    return { status: 0, body: null, err: e?.message ?? String(e) };
  }
}

export function extractIds(body: any): string[] {
  if (!body || typeof body !== 'object') return [];
  // OpenAI shape
  if (Array.isArray(body.data)) return body.data.map((m: any) => m.id ?? m.name).filter(Boolean);
  // Google shape
  if (Array.isArray(body.models)) return body.models.map((m: any) => (m.name ?? m.id ?? '').replace(/^models\//, '')).filter(Boolean);
  // GitHub catalog shape (array at top level)
  if (Array.isArray(body)) return body.map((m: any) => m.id ?? m.name ?? m.original_name).filter(Boolean);
  return [];
}

export async function discoverLiveModels(pool: pg.Pool): Promise<DiscoveryResult> {
  const keys = await all<KeyRow>(pool,
    `SELECT platform, encrypted_key, iv, auth_tag, status FROM api_keys WHERE enabled = true ORDER BY platform`);

  const out: DiscoveryResult = {};

  for (const k of keys) {
    let apiKey: string;
    try { apiKey = decrypt(k.encrypted_key, k.iv, k.auth_tag); }
    catch (e: any) { out[k.platform] = { status: -1, ids: [], err: `decrypt failed: ${e?.message}` }; continue; }

    if (k.platform === 'google') {
      const r = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=1000`, {});
      out.google = { status: r.status, ids: extractIds(r.body), err: r.err };
      continue;
    }
    if (k.platform === 'cloudflare') {
      const sep = apiKey.indexOf(':');
      const accountId = sep === -1 ? '' : apiKey.slice(0, sep);
      const token = sep === -1 ? apiKey : apiKey.slice(sep + 1);
      const r = await fetchJson(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=1000`, { Authorization: `Bearer ${token}` });
      const ids = Array.isArray(r.body?.result) ? r.body.result.map((m: any) => m.name).filter(Boolean) : [];
      out.cloudflare = { status: r.status, ids, err: r.err };
      continue;
    }

    const cfg = OPENAI_COMPAT[k.platform];
    if (!cfg) { out[k.platform] = { status: -2, ids: [], err: 'no endpoint mapping' }; continue; }
    const r = await fetchJson(cfg.url, { Authorization: `Bearer ${apiKey}`, ...(cfg.headers ?? {}) });
    out[k.platform] = { status: r.status, ids: extractIds(r.body), err: r.err };
  }

  return out;
}
