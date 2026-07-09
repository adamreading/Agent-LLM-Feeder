import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPool } from '../db/index.js';
import { all, get } from '../db/pgCompat.js';
import { explainRouting } from '../services/router.js';

export const fallbackRouter = Router();

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

  function parseBudget(s: string): number {
    const m = s.match(/~?([\d.]+)(?:-([\d.]+))?([MK])?/);
    if (!m) return 0;
    const high = parseFloat(m[2] ?? m[1]);
    const unit = m[3] === 'M' ? 1_000_000 : m[3] === 'K' ? 1_000 : 1;
    return high * unit;
  }

  const modelBudgets = models
    .filter(m => platformSet.has(m.platform))
    .map(m => ({ displayName: m.display_name, platform: m.platform, budget: parseBudget(m.monthly_token_budget) }));

  const totalBudget = modelBudgets.reduce((s, m) => s + m.budget, 0);

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
