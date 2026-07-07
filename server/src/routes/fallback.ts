import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getPool } from '../db/index.js';
import { all, get, run, transaction } from '../db/pgCompat.js';
import { getAllPenalties } from '../services/router.js';

export const fallbackRouter = Router();

// Get fallback chain (with dynamic penalties)
fallbackRouter.get('/', async (_req: Request, res: Response) => {
  const pool = getPool();
  const rows = await all<any>(pool, `
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.monthly_token_budget
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    ORDER BY fc.priority ASC
  `);

  // Count enabled keys per platform
  const keyCounts = await all<{ platform: string; count: string }>(pool, `
    SELECT platform, COUNT(*) as count
    FROM api_keys WHERE enabled = true
    GROUP BY platform
  `);
  const keyCountMap = new Map(keyCounts.map(k => [k.platform, Number(k.count)]));

  // Get current dynamic penalties
  const penalties = getAllPenalties();
  const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));

  res.json(rows.map(r => {
    const penalty = penaltyMap.get(r.model_db_id);
    return {
      modelDbId: r.model_db_id,
      priority: r.priority,
      effectivePriority: r.priority + (penalty?.penalty ?? 0),
      penalty: penalty?.penalty ?? 0,
      rateLimitHits: penalty?.count ?? 0,
      enabled: r.enabled,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      intelligenceRank: r.intelligence_rank,
      speedRank: r.speed_rank,
      sizeLabel: r.size_label,
      rpmLimit: r.rpm_limit,
      rpdLimit: r.rpd_limit,
      monthlyTokenBudget: r.monthly_token_budget,
      keyCount: keyCountMap.get(r.platform) ?? 0,
    };
  }));
});

const updateSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

// Update fallback chain (full replace)
fallbackRouter.put('/', async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  await transaction(getPool(), async (client) => {
    for (const entry of parsed.data) {
      await run(client, `UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?`, [
        entry.priority, entry.enabled, entry.modelDbId,
      ]);
    }
  });

  res.json({ success: true });
});

// Sort presets — `orderBy` is selected from a fixed whitelist, never from
// user input directly, so the interpolation below is safe.
const SORT_PRESETS: Record<string, string> = {
  intelligence: 'm.intelligence_rank ASC',
  speed: 'm.speed_rank ASC',
  budget: "CASE m.monthly_token_budget WHEN '~120M' THEN 1 WHEN '~50-100M' THEN 2 WHEN '~30M' THEN 3 WHEN '~18-45M' THEN 4 WHEN '~18M' THEN 5 WHEN '~15M' THEN 6 WHEN '~12M' THEN 7 WHEN '~6M' THEN 8 WHEN '~5-10M' THEN 9 WHEN '~4M' THEN 10 ELSE 11 END ASC",
};

fallbackRouter.post('/sort/:preset', async (req: Request, res: Response) => {
  const preset = String(req.params.preset);
  const orderBy = SORT_PRESETS[preset];
  if (!orderBy) {
    res.status(400).json({ error: { message: `Unknown preset: ${preset}. Use: intelligence, speed, budget` } });
    return;
  }

  const models = await all<{ id: number }>(getPool(), `SELECT m.id FROM models m ORDER BY ${orderBy}`);

  await transaction(getPool(), async (client) => {
    for (let i = 0; i < models.length; i++) {
      await run(client, 'UPDATE fallback_config SET priority = ? WHERE model_db_id = ?', [i + 1, models[i].id]);
    }
  });

  res.json({ success: true, preset });
});

// Token usage per model for the stacked bar
fallbackRouter.get('/token-usage', async (_req: Request, res: Response) => {
  const pool = getPool();

  // Get platforms that have enabled keys
  const platforms = await all<{ platform: string }>(pool, `
    SELECT DISTINCT ak.platform
    FROM api_keys ak
    WHERE ak.enabled = true
  `);
  const platformSet = new Set(platforms.map(p => p.platform));

  // Get monthly budget per model, ordered by fallback priority
  const models = await all<{ platform: string; model_id: string; display_name: string; monthly_token_budget: string; priority: number }>(pool, `
    SELECT m.platform, m.model_id, m.display_name, m.monthly_token_budget,
           fc.priority
    FROM models m
    JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE m.enabled = true
    ORDER BY fc.priority ASC
  `);

  function parseBudget(s: string): number {
    const m = s.match(/~?([\d.]+)(?:-([\d.]+))?([MK])?/);
    if (!m) return 0;
    const high = parseFloat(m[2] ?? m[1]);
    const unit = m[3] === 'M' ? 1_000_000 : m[3] === 'K' ? 1_000 : 1;
    return high * unit;
  }

  // Build per-model breakdown (only platforms with keys)
  const modelBudgets = models
    .filter(m => platformSet.has(m.platform))
    .map(m => ({
      displayName: m.display_name,
      platform: m.platform,
      budget: parseBudget(m.monthly_token_budget),
    }));

  const totalBudget = modelBudgets.reduce((s, m) => s + m.budget, 0);

  // Tokens used this month
  const usage = await get<{ total_used: string }>(pool, `
    SELECT
      COALESCE(SUM(input_tokens + output_tokens), 0) as total_used
    FROM requests
    WHERE created_at >= date_trunc('month', now())
  `);

  res.json({
    totalBudget,
    totalUsed: Number(usage?.total_used ?? 0),
    models: modelBudgets,
  });
});
