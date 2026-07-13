// Populate free-tier rate limits + monthly-budget notes from provider DOCS
// (researched 2026-07-13 via web search across each provider's official
// rate-limit documentation — see per-provider source URLs in comments). These
// are NOT returned by any provider API (only live x-ratelimit-* response
// headers give REMAINING quota, harvested separately); the documented caps
// live only in docs, so they're seeded here. No guessing: where a provider
// stopped publishing free-tier numbers (Google, Mistral) or never did (Zhipu,
// OpenCode), rpm/rpd/tpm/tpd stay null and only a descriptive budget note is
// set. Usage: npx tsx src/scripts/populate-ratelimits.ts
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, run } from '../db/pgCompat.js';

type Lim = { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null; budget: string };
const mo = (tpd: number | null) => (tpd ? `~${Math.round((tpd * 30) / 1e6)}M/mo` : '');

// Groq — per-model (console.groq.com/docs/rate-limits)
const GROQ: Record<string, [number, number | null, number, number | null]> = {
  'llama-3.3-70b-versatile': [30, 1000, 12000, 100000],
  'llama-3.1-8b-instant': [30, 14400, 6000, 500000],
  'openai/gpt-oss-120b': [30, 1000, 8000, 200000],
  'openai/gpt-oss-20b': [30, 1000, 8000, 200000],
  'qwen/qwen3-32b': [60, 1000, 6000, 500000],
  'meta-llama/llama-4-scout-17b-16e-instruct': [30, 1000, 30000, 500000],
  'groq/compound': [30, 250, 70000, null],
  'groq/compound-mini': [30, 250, 70000, null],
};

async function setLim(id: number, l: Partial<Lim>) {
  await run(getPool(), `UPDATE models SET
    rpm_limit = COALESCE(?, rpm_limit), rpd_limit = COALESCE(?, rpd_limit),
    tpm_limit = COALESCE(?, tpm_limit), tpd_limit = COALESCE(?, tpd_limit),
    monthly_token_budget = CASE WHEN ? <> '' THEN ? ELSE monthly_token_budget END
    WHERE id = ?`,
    [l.rpm ?? null, l.rpd ?? null, l.tpm ?? null, l.tpd ?? null, l.budget ?? '', l.budget ?? '', id]);
}

async function main() {
  await initDb();
  const rows = await all<{ id: number; platform: string; model_id: string; monthly_token_budget: string }>(getPool(),
    `SELECT id, platform, model_id, monthly_token_budget FROM models WHERE enabled = true`);
  let touched = 0;

  for (const m of rows) {
    let l: Partial<Lim> | null = null;
    switch (m.platform) {
      case 'groq': {
        const g = GROQ[m.model_id];
        if (g) l = { rpm: g[0], rpd: g[1], tpm: g[2], tpd: g[3], budget: g[3] ? mo(g[3]) : 'Free: 250 req/day' };
        else l = { budget: 'Free tier (per-model caps, console.groq.com)' }; // e.g. qwen3.6-27b not in doc table
        break;
      }
      case 'cerebras': // inference-docs.cerebras.ai/support/rate-limits — 5 RPM, 30K TPM, 1M tok/day
        l = { rpm: 5, tpm: 30000, tpd: 1000000, budget: '~30M/mo (1M tok/day free)' }; break;
      case 'sambanova': // docs.sambanova.ai — 20 RPM, 20 RPD, 200K tok/day per model (free)
        l = { rpm: 20, rpd: 20, tpd: 200000, budget: '~6M/mo (200K tok/day, 20 req/day free)' }; break;
      case 'openrouter': // openrouter.ai/docs — free variants: 20 RPM, 50/day (1000/day with >=10 credits)
        l = { rpm: 20, rpd: 50, budget: 'Free: 20 RPM · 50/day (1K/day with credits)' }; break;
      case 'nvidia': // build.nvidia.com — 40 RPM global; credit-based (~1000 signup credits)
        l = { rpm: 40, budget: '~1000 credits (signup); 40 RPM' }; break;
      case 'github': { // docs.github.com/github-models — tiered
        if (/deepseek-r1/i.test(m.model_id)) l = { rpm: 1, rpd: 8, budget: 'Free: 1 RPM · 8/day (advanced tier)' };
        else l = { rpm: 10, rpd: 50, budget: 'Free: 10 RPM · 50/day (High tier)' };
        break;
      }
      case 'kilo': l = { budget: 'Free: 200 req/hr per IP' }; break;
      case 'opencode': l = { budget: 'Free (limited-time; no published caps)' }; break;
      case 'zhipu': l = { budget: 'Free Flash tier (concurrency-limited)' }; break;
      case 'mistral': l = { budget: 'Free tier (restrictive; limits in admin console)' }; break;
      case 'google': l = { budget: 'Free tier (limits per-project in AI Studio)' }; break;
    }
    if (l) { await setLim(m.id, l); touched++; }
  }
  console.log(`Updated rate-limit/budget for ${touched} enabled models.`);
  const check = await all<{ platform: string; has_budget: string; enabled: string }>(getPool(), `
    SELECT platform, count(*) FILTER (WHERE monthly_token_budget<>'' AND monthly_token_budget<>'0') has_budget, count(*) enabled
    FROM models WHERE enabled GROUP BY platform ORDER BY platform`);
  for (const c of check) console.log(`  ${c.platform.padEnd(11)} budget ${c.has_budget}/${c.enabled}`);
  await closeDb();
}
main().catch(e => { console.error(e); process.exit(1); });
