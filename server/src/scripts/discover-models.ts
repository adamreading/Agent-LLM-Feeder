// One-shot authoritative discovery: hit every provider key's GET /models
// endpoint and dump the live model-id list the key can actually see. Written
// 2026-07-12 for the honest-wiki rebuild — the source of truth for catalog
// reconciliation (dead ids out, missing ids in). GET-only: no completion
// tokens burned. Usage: npx tsx src/scripts/discover-models.ts
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all } from '../db/pgCompat.js';
import { decrypt } from '../lib/crypto.js';
import { writeFileSync } from 'node:fs';

interface KeyRow { platform: string; encrypted_key: string; iv: string; auth_tag: string; status: string }

// baseUrls mirror providers/index.ts (duplicated intentionally for a one-shot
// discovery tool — no coupling to provider internals).
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

function extractIds(platform: string, body: any): string[] {
  if (!body || typeof body !== 'object') return [];
  // OpenAI shape
  if (Array.isArray(body.data)) return body.data.map((m: any) => m.id ?? m.name).filter(Boolean);
  // Google shape
  if (Array.isArray(body.models)) return body.models.map((m: any) => (m.name ?? m.id ?? '').replace(/^models\//, '')).filter(Boolean);
  // GitHub catalog shape (array at top level)
  if (Array.isArray(body)) return body.map((m: any) => m.id ?? m.name ?? m.original_name).filter(Boolean);
  return [];
}

async function main() {
  await initDb();
  const pool = getPool();
  const keys = await all<KeyRow>(pool,
    `SELECT platform, encrypted_key, iv, auth_tag, status FROM api_keys WHERE enabled = true ORDER BY platform`);

  const out: Record<string, { status: number; count: number; ids: string[]; err?: string }> = {};

  for (const k of keys) {
    let apiKey: string;
    try { apiKey = decrypt(k.encrypted_key, k.iv, k.auth_tag); }
    catch (e: any) { out[k.platform] = { status: -1, count: 0, ids: [], err: `decrypt failed: ${e?.message}` }; continue; }

    if (k.platform === 'google') {
      const r = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=1000`, {});
      const ids = extractIds('google', r.body);
      out.google = { status: r.status, count: ids.length, ids, err: r.err };
      console.log(`[google] HTTP ${r.status} — ${ids.length} models`);
      continue;
    }
    if (k.platform === 'cloudflare') {
      const sep = apiKey.indexOf(':');
      const accountId = sep === -1 ? '' : apiKey.slice(0, sep);
      const token = sep === -1 ? apiKey : apiKey.slice(sep + 1);
      const r = await fetchJson(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=1000`, { Authorization: `Bearer ${token}` });
      const ids = Array.isArray(r.body?.result) ? r.body.result.map((m: any) => m.name).filter(Boolean) : [];
      out.cloudflare = { status: r.status, count: ids.length, ids, err: r.err };
      console.log(`[cloudflare] HTTP ${r.status} — ${ids.length} models`);
      continue;
    }

    const cfg = OPENAI_COMPAT[k.platform];
    if (!cfg) { out[k.platform] = { status: -2, count: 0, ids: [], err: 'no endpoint mapping' }; continue; }
    const r = await fetchJson(cfg.url, { Authorization: `Bearer ${apiKey}`, ...(cfg.headers ?? {}) });
    const ids = extractIds(k.platform, r.body);
    out[k.platform] = { status: r.status, count: ids.length, ids, err: r.err };
    console.log(`[${k.platform}] HTTP ${r.status} — ${ids.length} models${r.err ? ' ERR:' + r.err : ''}${r.status >= 400 && typeof r.body === 'object' ? ' ' + JSON.stringify(r.body).slice(0, 150) : ''}`);
  }

  const path = '/tmp/claude-1000/-home-ajo-Agent-LLM-Feeder/2fbd53c3-4337-4fed-bc4e-4a9d2a10ee4e/scratchpad/live-models.json';
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${path}`);
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
