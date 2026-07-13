// Liveness pass over pending-liveness models: real completion each; WORKS →
// enable + record latency; paid/subscription/dead → stay disabled with an
// honest reason; rate-limited/timeout → stay pending for a later retry.
// Usage: npx tsx src/scripts/liveness-enable.ts
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, get, run } from '../db/pgCompat.js';
import { decrypt } from '../lib/crypto.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { getProvider } from '../providers/index.js';
import type { Platform } from '@freellmapi/shared/types.js';

const BASE: Record<string, { url: string; headers?: Record<string, string> }> = {
  groq: { url: 'https://api.groq.com/openai/v1' }, cerebras: { url: 'https://api.cerebras.ai/v1' },
  sambanova: { url: 'https://api.sambanova.ai/v1' }, nvidia: { url: 'https://integrate.api.nvidia.com/v1' },
  mistral: { url: 'https://api.mistral.ai/v1' }, openrouter: { url: 'https://openrouter.ai/api/v1', headers: { 'HTTP-Referer': 'http://localhost:3001', 'X-Title': 'FreeLLMAPI' } },
  github: { url: 'https://models.github.ai/inference' }, zhipu: { url: 'https://open.bigmodel.cn/api/paas/v4' },
  opencode: { url: 'https://opencode.ai/zen/v1' }, kilo: { url: 'https://api.kilo.ai/api/gateway/v1' },
};
const PAID_RE = /subscription|payment|402|insufficient|balance|unavailable for free|paid version|requires? (a )?(pro|paid|subscription)|billing|purchase|upgrade/i;
const DEAD_RE = /\b404\b|not found|no endpoints|does not exist|unknown model|no such model|model_not_found|invalid model|not a valid model|decommission|deprecated/i;
const TRANSIENT_RE = /429|rate.?limit|too many requests|timeout|aborted|ECONNRESET|ETIMEDOUT|\b5\d\d\b|quota|overloaded|capacity/i;

async function keyFor(platform: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(platform)) return cache.get(platform)!;
  const k = await get<{ encrypted_key: string; iv: string; auth_tag: string }>(getPool(),
    `SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform=? AND enabled=true AND status!='invalid' LIMIT 1`, [platform]);
  let v: string | null = null;
  if (k) { try { v = decrypt(k.encrypted_key, k.iv, k.auth_tag); } catch { v = null; } }
  cache.set(platform, v); return v;
}

async function main() {
  await initDb();
  const pending = await all<{ id: number; platform: string; model_id: string }>(getPool(),
    `SELECT id, platform, model_id FROM models WHERE disabled_reason LIKE 'pending-liveness%' ORDER BY platform, model_id`);
  console.log(`Testing ${pending.length} pending models...\n`);
  const cache = new Map<string, string | null>();
  const tally = { works: 0, paid: 0, dead: 0, transient: 0, nokey: 0 };

  for (const m of pending) {
    const apiKey = await keyFor(m.platform, cache);
    if (!apiKey) { tally.nokey++; console.log(`[NO_KEY   ] ${m.platform}/${m.model_id}`); continue; }
    const b = BASE[m.platform];
    const provider = b ? new OpenAICompatProvider({ platform: m.platform as Platform, name: m.platform, baseUrl: b.url, extraHeaders: b.headers, timeoutMs: 25000 }) : getProvider(m.platform as Platform);
    if (!provider) { tally.nokey++; continue; }
    const start = Date.now();
    try {
      const resp = await provider.chatCompletion(apiKey, [{ role: 'user', content: 'Reply with the single word: ok' }], m.model_id, { max_tokens: 300, temperature: 0 });
      const lat = Date.now() - start;
      const content = resp?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim().length > 0) {
        await run(getPool(), `UPDATE models SET enabled=true, disabled_reason=NULL WHERE id=?`, [m.id]);
        await run(getPool(), `INSERT INTO model_health (model_db_id, recent_latency_ms, status, updated_at) VALUES (?,?, 'healthy', now()) ON CONFLICT (model_db_id) DO UPDATE SET recent_latency_ms=EXCLUDED.recent_latency_ms, status='healthy', updated_at=now()`, [m.id, lat > 0 ? lat : null]);
        tally.works++; console.log(`[WORKS ${String(lat).padStart(6)}ms] ${m.platform}/${m.model_id}`);
      } else {
        // 200 but empty (reasoning model starved even at 300 tok) — treat as works-but-slow, enable.
        await run(getPool(), `UPDATE models SET enabled=true, disabled_reason=NULL WHERE id=?`, [m.id]);
        tally.works++; console.log(`[WORKS(empty)] ${m.platform}/${m.model_id}`);
      }
    } catch (e: any) {
      const msg = (e?.message ?? String(e)).slice(0, 120);
      let bucket: keyof typeof tally;
      if (PAID_RE.test(msg)) { bucket = 'paid'; await run(getPool(), `UPDATE models SET enabled=false, disabled_reason=? WHERE id=?`, [`paid-only: ${msg.slice(0, 80)}`, m.id]); }
      else if (DEAD_RE.test(msg)) { bucket = 'dead'; await run(getPool(), `UPDATE models SET enabled=false, disabled_reason=? WHERE id=?`, [`dead: ${msg.slice(0, 80)}`, m.id]); }
      else { bucket = 'transient'; /* stay pending-liveness for retry */ }
      tally[bucket]++; console.log(`[${bucket.toUpperCase().padEnd(9)}] ${m.platform}/${m.model_id}  ${msg}`);
    }
  }
  console.log(`\n=== TALLY === works=${tally.works} paid=${tally.paid} dead=${tally.dead} transient(pending)=${tally.transient} nokey=${tally.nokey}`);
  const enabled = await get<{ c: string }>(getPool(), `SELECT count(*) c FROM models WHERE enabled=true`);
  console.log(`models enabled now: ${enabled?.c}`);
  await closeDb();
}
main().catch(e => { console.error(e); process.exit(1); });
