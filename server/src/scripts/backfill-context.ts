// Backfill models.context_window from each provider's AUTHORITATIVE /models
// metadata (GET-only, no guessing) for enabled rows that are missing it. Only
// fills from a real provider-declared field — never a hardcoded guess. Fields
// seen across providers: context_length (openrouter), inputTokenLimit +
// outputTokenLimit (google), max_context_length / context_window / max_model_len
// (various NIM/vLLM), max_input_tokens. Usage:
//   npx tsx src/scripts/backfill-context.ts
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, run } from '../db/pgCompat.js';
import { decrypt } from '../lib/crypto.js';

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
  opencode: { url: 'https://opencode.ai/zen/v1/models' },
  google: { url: 'https://generativelanguage.googleapis.com/v1beta/models', google: true },
};

function ctxOf(m: any): number | null {
  const cands = [m.context_length, m.context_window, m.max_context_length, m.max_model_len,
    m.max_input_tokens, m.inputTokenLimit, m?.top_provider?.context_length,
    m?.limits?.max_context_window_tokens, m?.max_tokens];
  for (const c of cands) { const n = Number(c); if (Number.isFinite(n) && n >= 512) return Math.round(n); }
  return null;
}

async function main() {
  await initDb();
  const keys = await all<{ platform: string; encrypted_key: string; iv: string; auth_tag: string }>(getPool(),
    `SELECT platform, encrypted_key, iv, auth_tag FROM api_keys WHERE enabled=true`);
  let filled = 0, stillNull = 0;

  for (const k of keys) {
    const ep = ENDPOINT[k.platform];
    if (!ep) continue;
    let apiKey: string; try { apiKey = decrypt(k.encrypted_key, k.iv, k.auth_tag); } catch { continue; }
    const url = ep.google ? `${ep.url}?key=${apiKey}&pageSize=1000` : ep.url;
    const headers = ep.google ? {} : { Authorization: `Bearer ${apiKey}`, ...(ep.headers ?? {}) };
    let body: any;
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, { headers, signal: ctrl.signal }); clearTimeout(t);
      body = await res.json();
    } catch { continue; }
    let models: any[] = [];
    if (Array.isArray(body?.data)) models = body.data;
    else if (Array.isArray(body?.models)) models = body.models.map((m: any) => ({ ...m, id: (m.name ?? m.id ?? '').replace(/^models\//, '') }));
    else if (Array.isArray(body)) models = body;

    // ctx map keyed by exact provider id
    const ctxById = new Map<string, number>();
    for (const m of models) { const id = String(m.id ?? m.name ?? ''); const c = ctxOf(m); if (id && c) ctxById.set(id, c); }

    // enabled rows on this platform still missing context
    const rows = await all<{ id: number; model_id: string }>(getPool(),
      `SELECT id, model_id FROM models WHERE platform=? AND enabled=true AND context_window IS NULL`, [k.platform]);
    for (const r of rows) {
      const c = ctxById.get(r.model_id);
      if (c) { await run(getPool(), `UPDATE models SET context_window=? WHERE id=?`, [c, r.id]); filled++; console.log(`  [${k.platform}] ${r.model_id} -> ${c}`); }
      else stillNull++;
    }
  }
  console.log(`\nFilled ${filled}; still null (provider didn't expose it) ${stillNull}.`);
  const summary = await all<{ null_ctx: string; total: string }>(getPool(), `SELECT count(*) FILTER (WHERE context_window IS NULL) null_ctx, count(*) total FROM models WHERE enabled=true`);
  console.log(`enabled models still missing context_window: ${summary[0].null_ctx}/${summary[0].total}`);
  await closeDb();
}
main().catch(e => { console.error(e); process.exit(1); });
