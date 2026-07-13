// Targeted re-probe of enabled models that currently have NO supported
// tools/json_mode measured row — most were rate-limited / cold-timed-out
// during the 15s full sweep (esp. NVIDIA). Uses a 60s-timeout provider so a
// cold NIM model gets a fair test. Records via recordProbeResult (404/transient
// still skipped, not poisoned). Usage: npx tsx src/scripts/reprobe-nocaps.ts
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, get } from '../db/pgCompat.js';
import { decrypt } from '../lib/crypto.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { getProvider } from '../providers/index.js';
import { recordProbeResult, type ProbeContext } from '../services/probes/runner.js';
import { probeTools, probeJsonMode } from '../services/probes/methods.js';
import type { Platform } from '@freellmapi/shared/types.js';

const BASE: Record<string, { url: string; headers?: Record<string, string> }> = {
  groq: { url: 'https://api.groq.com/openai/v1' }, cerebras: { url: 'https://api.cerebras.ai/v1' },
  sambanova: { url: 'https://api.sambanova.ai/v1' }, nvidia: { url: 'https://integrate.api.nvidia.com/v1' },
  mistral: { url: 'https://api.mistral.ai/v1' }, openrouter: { url: 'https://openrouter.ai/api/v1', headers: { 'HTTP-Referer': 'http://localhost:3001', 'X-Title': 'FreeLLMAPI' } },
  github: { url: 'https://models.github.ai/inference' }, zhipu: { url: 'https://open.bigmodel.cn/api/paas/v4' },
  opencode: { url: 'https://opencode.ai/zen/v1' }, kilo: { url: 'https://api.kilo.ai/api/gateway/v1' },
};

async function main() {
  await initDb();
  // enabled models with no supported tools OR json_mode measured row
  const rows = await all<{ id: number; platform: string; model_id: string }>(getPool(), `
    SELECT m.id, m.platform, m.model_id FROM models m
    WHERE m.enabled = true
      AND NOT EXISTS (SELECT 1 FROM model_capabilities mc WHERE mc.model_db_id=m.id AND mc.source='measured' AND mc.supported=true AND mc.capability IN ('tools','json_mode'))
    ORDER BY m.platform, m.model_id`);
  console.log(`Re-probing ${rows.length} models with 60s timeout...\n`);
  const cache = new Map<string, string | null>();

  for (const m of rows) {
    if (!cache.has(m.platform)) {
      const k = await get<{ encrypted_key: string; iv: string; auth_tag: string }>(getPool(),
        `SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform=? AND enabled=true AND status!='invalid' LIMIT 1`, [m.platform]);
      cache.set(m.platform, k ? decrypt(k.encrypted_key, k.iv, k.auth_tag) : null);
    }
    const apiKey = cache.get(m.platform);
    if (!apiKey) { console.log(`[no-key] ${m.platform}/${m.model_id}`); continue; }
    const b = BASE[m.platform];
    const provider = b ? new OpenAICompatProvider({ platform: m.platform as Platform, name: m.platform, baseUrl: b.url, extraHeaders: b.headers, timeoutMs: 60000 }) : getProvider(m.platform as Platform);
    if (!provider) continue;
    const ctx: ProbeContext = { provider, apiKey, modelId: m.model_id, modelDbId: m.id, platform: m.platform };
    try {
      const t = await probeTools(ctx); await recordProbeResult('tools', ctx, t, false);
      const j = await probeJsonMode(ctx); await recordProbeResult('json_mode', ctx, j, false);
      console.log(`[${m.platform}/${m.model_id}] tools=${t.transient ? 'skip' : t.passed} json_mode=${j.transient ? 'skip' : j.passed}`);
    } catch (e: any) {
      console.log(`[${m.platform}/${m.model_id}] ERROR ${e.message?.slice(0, 70)}`);
    }
  }
  await closeDb();
  console.log('\nreprobe done');
}
main().catch(e => { console.error(e); process.exit(1); });
