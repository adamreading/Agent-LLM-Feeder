// Retry pass for TRANSIENT/EMPTY liveness verdicts with a 60s timeout and
// enough max_tokens for reasoning models to emit an answer after thinking.
// Reads liveness.json, retries those, updates model_health for new WORKS.
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { get, run } from '../db/pgCompat.js';
import { decrypt } from '../lib/crypto.js';
import { getProvider } from '../providers/index.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Platform } from '@freellmapi/shared/types.js';

const BASE: Record<string, { url: string; headers?: Record<string, string> }> = {
  groq: { url: 'https://api.groq.com/openai/v1' },
  cerebras: { url: 'https://api.cerebras.ai/v1' },
  sambanova: { url: 'https://api.sambanova.ai/v1' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1' },
  mistral: { url: 'https://api.mistral.ai/v1' },
  openrouter: { url: 'https://openrouter.ai/api/v1', headers: { 'HTTP-Referer': 'http://localhost:3001', 'X-Title': 'FreeLLMAPI' } },
  github: { url: 'https://models.github.ai/inference' },
  zhipu: { url: 'https://open.bigmodel.cn/api/paas/v4' },
  opencode: { url: 'https://opencode.ai/zen/v1' },
};

const DEAD_RE = /\b404\b|not found|no endpoints|not available|does not exist|unknown model|no such model|model_not_found|invalid model/i;
const TRANSIENT_RE = /429|rate.?limit|too many requests|timeout|aborted|ECONNRESET|ETIMEDOUT|\b5\d\d\b|quota|overloaded/i;

async function keyFor(platform: string): Promise<string | null> {
  const k = await get<{ encrypted_key: string; iv: string; auth_tag: string }>(getPool(),
    `SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform=? AND enabled=true AND status!='invalid' LIMIT 1`, [platform]);
  if (!k) return null;
  try { return decrypt(k.encrypted_key, k.iv, k.auth_tag); } catch { return null; }
}

async function main() {
  await initDb();
  const prev = JSON.parse(readFileSync('/tmp/claude-1000/-home-ajo-Agent-LLM-Feeder/2fbd53c3-4337-4fed-bc4e-4a9d2a10ee4e/scratchpad/liveness.json', 'utf8'));
  const retryList = prev.results.filter((r: any) => r.verdict === 'TRANSIENT' || r.verdict === 'EMPTY');
  const keyCache = new Map<string, string | null>();
  const out: any[] = [];

  for (const m of retryList) {
    if (!keyCache.has(m.platform)) keyCache.set(m.platform, await keyFor(m.platform));
    const apiKey = keyCache.get(m.platform);
    if (!apiKey) { out.push({ ...m, retry: 'NO_KEY' }); continue; }

    // Build a 60s-timeout provider for openai-compat; use registered provider for google.
    let provider;
    const b = BASE[m.platform];
    if (b) provider = new OpenAICompatProvider({ platform: m.platform as Platform, name: m.platform, baseUrl: b.url, extraHeaders: b.headers, timeoutMs: 60000 });
    else provider = getProvider(m.platform as Platform);
    if (!provider) { out.push({ ...m, retry: 'NO_PROVIDER' }); continue; }

    const start = Date.now();
    try {
      const resp = await provider.chatCompletion(apiKey, [{ role: 'user', content: 'Reply with the single word: ok' }], m.model_id, { max_tokens: 300, temperature: 0 });
      const latencyMs = Date.now() - start;
      const content = resp?.choices?.[0]?.message?.content;
      const has = typeof content === 'string' && content.trim().length > 0;
      out.push({ ...m, retry: has ? 'WORKS' : 'EMPTY', retryDetail: has ? content!.trim().slice(0, 40) : JSON.stringify(resp?.choices?.[0] ?? {}).slice(0, 80), retryLatencyMs: latencyMs });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      out.push({ ...m, retry: DEAD_RE.test(msg) ? 'DEAD' : TRANSIENT_RE.test(msg) ? 'TRANSIENT' : 'FAIL', retryDetail: msg.slice(0, 90), retryLatencyMs: Date.now() - start });
    }
    const r = out[out.length - 1];
    console.log(`[${r.retry.padEnd(9)}] ${r.platform.padEnd(11)} ${r.model_id.padEnd(45)} ${r.retryLatencyMs}ms  ${r.retryDetail}`);
  }

  for (const r of out.filter((x) => x.retry === 'WORKS' && x.retryLatencyMs > 0)) {
    await run(getPool(), `
      INSERT INTO model_health (model_db_id, recent_latency_ms, status, updated_at)
      VALUES (?, ?, 'healthy', now())
      ON CONFLICT (model_db_id) DO UPDATE SET recent_latency_ms=EXCLUDED.recent_latency_ms, status='healthy', updated_at=now()
    `, [r.id, r.retryLatencyMs]);
  }
  const summary = { retried: out.length, works: out.filter(x => x.retry === 'WORKS').length, still_transient: out.filter(x => x.retry === 'TRANSIENT').length, dead: out.filter(x => x.retry === 'DEAD').length, empty: out.filter(x => x.retry === 'EMPTY').length, fail: out.filter(x => x.retry === 'FAIL').length };
  writeFileSync('/tmp/claude-1000/-home-ajo-Agent-LLM-Feeder/2fbd53c3-4337-4fed-bc4e-4a9d2a10ee4e/scratchpad/liveness-retry.json', JSON.stringify({ summary, out }, null, 2));
  console.log('\n=== RETRY SUMMARY ==='); console.log(JSON.stringify(summary, null, 2));
  await closeDb();
}
main().catch(e => { console.error(e); process.exit(1); });
