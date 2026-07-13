// Phase 3 of the honest-wiki rebuild (2026-07-12): prove each enabled model
// ACTUALLY WORKS with a real minimal completion (max_tokens small). One call
// per model. Classifies dead (404/not-found → disable) vs transient (429/
// timeout/5xx → keep, retry later) vs works. Also tests re-enable candidates.
// Usage: npx tsx src/scripts/liveness-test.ts
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, get, run } from '../db/pgCompat.js';
import { decrypt } from '../lib/crypto.js';
import { getProvider } from '../providers/index.js';
import { writeFileSync } from 'node:fs';
import type { Platform } from '@freellmapi/shared/types.js';

interface ModelRow { id: number; platform: string; model_id: string; enabled: boolean }

const DEAD_RE = /\b404\b|not found|no endpoints|not available|does not exist|unknown model|no such model|model_not_found|invalid model|does not have access|not authorized to use/i;
const TRANSIENT_RE = /429|rate.?limit|too many requests|timeout|aborted|ECONNRESET|ETIMEDOUT|\b5\d\d\b|quota|overloaded/i;

async function keyFor(platform: string): Promise<string | null> {
  const k = await get<{ encrypted_key: string; iv: string; auth_tag: string }>(getPool(),
    `SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform=? AND enabled=true AND status!='invalid' LIMIT 1`, [platform]);
  if (!k) return null;
  try { return decrypt(k.encrypted_key, k.iv, k.auth_tag); } catch { return null; }
}

async function main() {
  const includeDisabled = process.argv.includes('--include-disabled');
  await initDb();
  const rows = await all<ModelRow>(getPool(),
    `SELECT id, platform, model_id, enabled FROM models WHERE enabled=true ${includeDisabled ? "OR id=63" : ''} ORDER BY platform, model_id`);

  const keyCache = new Map<string, string | null>();
  const results: Array<{ id: number; platform: string; model_id: string; verdict: string; detail: string; latencyMs: number }> = [];

  for (const m of rows) {
    if (!keyCache.has(m.platform)) keyCache.set(m.platform, await keyFor(m.platform));
    const apiKey = keyCache.get(m.platform);
    const provider = getProvider(m.platform as Platform);
    if (!apiKey || !provider) { results.push({ id: m.id, platform: m.platform, model_id: m.model_id, verdict: 'NO_KEY', detail: 'no key/provider', latencyMs: 0 }); continue; }

    const start = Date.now();
    try {
      const resp = await provider.chatCompletion(apiKey, [{ role: 'user', content: 'Reply with the single word: ok' }], m.model_id, { max_tokens: 16, temperature: 0 });
      const latencyMs = Date.now() - start;
      const content = resp?.choices?.[0]?.message?.content;
      const hasContent = typeof content === 'string' && content.trim().length > 0;
      results.push({ id: m.id, platform: m.platform, model_id: m.model_id, verdict: hasContent ? 'WORKS' : 'EMPTY', detail: hasContent ? content!.trim().slice(0, 40) : JSON.stringify(resp?.choices?.[0] ?? resp).slice(0, 80), latencyMs });
    } catch (e: any) {
      const latencyMs = Date.now() - start;
      const msg = e?.message ?? String(e);
      const verdict = DEAD_RE.test(msg) ? 'DEAD' : TRANSIENT_RE.test(msg) ? 'TRANSIENT' : 'FAIL';
      results.push({ id: m.id, platform: m.platform, model_id: m.model_id, verdict, detail: msg.slice(0, 90), latencyMs });
    }
    const r = results[results.length - 1];
    console.log(`[${r.verdict.padEnd(9)}] ${r.platform.padEnd(11)} ${r.model_id.padEnd(42)} ${r.latencyMs}ms  ${r.detail}`);
  }

  // Persist verified latency for models that WORK (real p-latency seed).
  for (const r of results.filter(x => x.verdict === 'WORKS')) {
    await run(getPool(), `
      INSERT INTO model_health (model_db_id, recent_latency_ms, status, updated_at)
      VALUES (?, ?, 'healthy', now())
      ON CONFLICT (model_db_id) DO UPDATE SET recent_latency_ms=EXCLUDED.recent_latency_ms, status='healthy', updated_at=now()
    `, [r.id, r.latencyMs]);
  }

  const summary = {
    total: results.length,
    works: results.filter(r => r.verdict === 'WORKS').length,
    empty: results.filter(r => r.verdict === 'EMPTY').length,
    dead: results.filter(r => r.verdict === 'DEAD').length,
    transient: results.filter(r => r.verdict === 'TRANSIENT').length,
    fail: results.filter(r => r.verdict === 'FAIL').length,
    no_key: results.filter(r => r.verdict === 'NO_KEY').length,
  };
  const path = '/tmp/claude-1000/-home-ajo-Agent-LLM-Feeder/2fbd53c3-4337-4fed-bc4e-4a9d2a10ee4e/scratchpad/liveness.json';
  writeFileSync(path, JSON.stringify({ summary, results }, null, 2));
  console.log('\n=== SUMMARY ==='); console.log(JSON.stringify(summary, null, 2)); console.log(`Wrote ${path}`);
  await closeDb();
}
main().catch(e => { console.error(e); process.exit(1); });
