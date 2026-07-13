// Enumerate FREE-tier candidate models per provider from /models metadata
// (GET-only, no completion tokens). Free detection is per-provider:
//  - openrouter/kilo: pricing.prompt==0 && completion==0, OR :free suffix
//  - opencode: id ends -free
//  - wholesale-free-tier providers (github/groq/cerebras/sambanova/google/
//    mistral/nvidia/zhipu): every listed model is free (rate-limited) — the
//    liveness pass drops any that return payment/subscription-required.
//  - llm7/pollinations: anonymous/free aggregators, take whole list.
// Usage: npx tsx src/scripts/enumerate-free.ts
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all } from '../db/pgCompat.js';
import { decrypt } from '../lib/crypto.js';
import { writeFileSync } from 'node:fs';

const WHOLESALE_FREE = new Set(['github', 'groq', 'cerebras', 'sambanova', 'google', 'mistral', 'nvidia', 'zhipu', 'llm7', 'pollinations']);

const ENDPOINT: Record<string, { url: string; headers?: Record<string, string>; google?: boolean }> = {
  groq: { url: 'https://api.groq.com/openai/v1/models' },
  cerebras: { url: 'https://api.cerebras.ai/v1/models' },
  sambanova: { url: 'https://api.sambanova.ai/v1/models' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/models' },
  mistral: { url: 'https://api.mistral.ai/v1/models' },
  openrouter: { url: 'https://openrouter.ai/api/v1/models', headers: { 'HTTP-Referer': 'http://localhost:3001', 'X-Title': 'FreeLLMAPI' } },
  github: { url: 'https://models.github.ai/catalog/models' },
  zhipu: { url: 'https://open.bigmodel.cn/api/paas/v4/models' },
  kilo: { url: 'https://api.kilo.ai/api/gateway/v1/models' },
  pollinations: { url: 'https://text.pollinations.ai/openai/v1/models' },
  llm7: { url: 'https://api.llm7.io/v1/models' },
  opencode: { url: 'https://opencode.ai/zen/v1/models' },
  google: { url: 'https://generativelanguage.googleapis.com/v1beta/models', google: true },
};

async function fetchJson(url: string, headers: Record<string, string>) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(url, { headers, signal: ctrl.signal }); clearTimeout(t);
    const text = await res.text(); let body: any; try { body = JSON.parse(text); } catch { body = null; }
    return { status: res.status, body };
  } catch (e: any) { return { status: 0, body: null, err: e?.message }; }
}

function priceZero(p: any): boolean {
  if (!p) return false;
  const nums = [p.prompt, p.completion, p.request, p.input, p.output].map((x) => (x == null ? 0 : Number(x)));
  return nums.every((n) => !Number.isNaN(n) && n === 0);
}

function isFree(platform: string, m: any): boolean {
  const id = String(m.id ?? m.name ?? '');
  if (platform === 'opencode') return /-free$/.test(id);
  if (platform === 'openrouter' || platform === 'kilo') return priceZero(m.pricing) || /:free$/.test(id);
  if (WHOLESALE_FREE.has(platform)) return true;
  return false;
}

async function main() {
  await initDb();
  const keys = await all<{ platform: string; encrypted_key: string; iv: string; auth_tag: string }>(getPool(),
    `SELECT platform, encrypted_key, iv, auth_tag FROM api_keys WHERE enabled=true ORDER BY platform`);
  const result: Record<string, { total: number; free: number; freeIds: string[]; note?: string }> = {};

  for (const k of keys) {
    const ep = ENDPOINT[k.platform];
    if (!ep) { result[k.platform] = { total: 0, free: 0, freeIds: [], note: 'no endpoint / not free-enumerable' }; continue; }
    let apiKey: string; try { apiKey = decrypt(k.encrypted_key, k.iv, k.auth_tag); } catch { result[k.platform] = { total: 0, free: 0, freeIds: [], note: 'decrypt failed' }; continue; }

    const url = ep.google ? `${ep.url}?key=${apiKey}&pageSize=1000` : ep.url;
    const headers = ep.google ? {} : { Authorization: `Bearer ${apiKey}`, ...(ep.headers ?? {}) };
    const r = await fetchJson(url, headers);
    let models: any[] = [];
    if (Array.isArray(r.body?.data)) models = r.body.data;
    else if (Array.isArray(r.body?.models)) models = r.body.models.map((m: any) => ({ ...m, id: (m.name ?? m.id ?? '').replace(/^models\//, '') }));
    else if (Array.isArray(r.body)) models = r.body;

    // Google: exclude non-generateContent models (embeddings/tts/imagen) — only chat models belong in the wiki.
    if (k.platform === 'google') {
      models = models.filter((m: any) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'));
      models = models.filter((m: any) => !/embedding|aqa|imagen|veo|tts|image-generation/i.test(String(m.id)));
    }
    const free = models.filter((m) => isFree(k.platform, m));
    result[k.platform] = { total: models.length, free: free.length, freeIds: free.map((m) => String(m.id ?? m.name)).sort(), note: r.status !== 200 ? `HTTP ${r.status}` : undefined };
    console.log(`[${k.platform.padEnd(11)}] total ${String(models.length).padStart(4)}  free ${String(free.length).padStart(4)}${r.status !== 200 ? '  HTTP ' + r.status : ''}`);
  }
  const total = Object.values(result).reduce((a, b) => a + b.free, 0);
  console.log(`\nTOTAL FREE CANDIDATES: ${total}`);
  writeFileSync('/tmp/claude-1000/-home-ajo-Agent-LLM-Feeder/2fbd53c3-4337-4fed-bc4e-4a9d2a10ee4e/scratchpad/free-candidates.json', JSON.stringify(result, null, 2));
  await closeDb();
}
main().catch(e => { console.error(e); process.exit(1); });
