import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPool } from '../db/index.js';
import { all, get } from '../db/pgCompat.js';
import { explainRouting } from '../services/router.js';

export const fallbackRouter = Router();

// Parse a human-authored monthly_token_budget note into a MONTHLY TOKEN count, or
// null when the note carries no genuine token figure. (2026-07-15, Adam) HONEST
// DISPLAY: a real monthly-token allowance is written with an M/K unit — "~6M/mo",
// "~18-45M", "~30M/mo (1M tok/day)". A BARE number in the note is an RPM/RPD/credit
// limit, NOT monthly tokens — "Free: 20 RPM · 50/day" or "~1000 credits; 40 RPM" —
// so returning that number as a token count was a misparse ("20 RPM" shown as 20
// tokens, "1000 credits" as 1K). We now require an M/K unit and return null
// otherwise, so the UI renders "—" instead of a fabricated count. Robust by
// construction: the match must start with a digit (URL dots like "console.groq.com"
// never match) and a Number.isFinite guard means no NaN can ever poison the sum.
export function monthlyTokenBudget(s: string | null | undefined): number | null {
  if (!s) return null;
  // Require an M (millions) unit: every genuine monthly-token allowance in the
  // catalogue is written in millions ("~6M/mo", "~18-45M"). K only ever shows up
  // in daily/credit SUB-figures ("1K/day", "200K tok/day", "1K/day with credits"),
  // never as the monthly headline — so matching K would re-introduce the misparse.
  const m = s.match(/~?(\d[\d.]*)(?:-(\d[\d.]*))?\s*M\b/i);
  if (!m) return null;
  const high = parseFloat(m[2] ?? m[1]);
  if (!Number.isFinite(high)) return null;
  return high * 1_000_000;
}

// READ-ONLY reality view: the real current effective priority order the router
// would use right now, computed with the SAME candidateScore + structural
// checks routeRequest uses, plus a per-model breakdown (intelligence rank,
// arena task score, penalty, health, latency, key count, status).
//
// This page DISPLAYS the order — it does NOT control it. Ordering is the
// algorithm's job now (intelligence prior + task quality + health + latency +
// ε-exploration), not a hand-maintained priority list. The old PUT (drag-
// reorder) and POST /sort/:preset (INTEL/SPEED/BUDGET buttons) that WROTE
// fallback_config.priority were removed for exactly that reason — they let the
// page silently override what the router chose.
//
// Optional ?taskClass= shows how the order shifts for a specific task
// (e.g. ?taskClass=math surfaces the strongest math models).
fallbackRouter.get('/order', async (req: Request, res: Response) => {
  const taskClass = typeof req.query.taskClass === 'string' ? req.query.taskClass : null;
  res.json(await explainRouting(taskClass));
});

// Token usage per model for the stacked budget bar (display only).
fallbackRouter.get('/token-usage', async (_req: Request, res: Response) => {
  const pool = getPool();

  const platforms = await all<{ platform: string }>(pool, `
    SELECT DISTINCT ak.platform FROM api_keys ak WHERE ak.enabled = true
  `);
  const platformSet = new Set(platforms.map(p => p.platform));

  const models = await all<{ platform: string; model_id: string; display_name: string; monthly_token_budget: string }>(pool, `
    SELECT m.platform, m.model_id, m.display_name, m.monthly_token_budget
    FROM models m
    JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE m.enabled = true
    ORDER BY m.intelligence_rank ASC
  `);

  const modelBudgets = models
    .filter(m => platformSet.has(m.platform))
    .map(m => ({ displayName: m.display_name, platform: m.platform, budget: monthlyTokenBudget(m.monthly_token_budget) }));

  // Sum only the models with a genuine monthly-token figure (null = no published
  // token cap → shown as "—", not counted).
  const totalBudget = modelBudgets.reduce((s, m) => s + (m.budget ?? 0), 0);

  const usage = await get<{ total_used: string }>(pool, `
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_used
    FROM requests WHERE created_at >= date_trunc('month', now())
  `);

  res.json({
    totalBudget,
    totalUsed: Number(usage?.total_used ?? 0),
    models: modelBudgets,
  });
});
