import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPool } from '../db/index.js';
import { all } from '../db/pgCompat.js';
import { hasProvider } from '../providers/index.js';

export const modelsRouter = Router();

// List all models with availability info
modelsRouter.get('/', async (_req: Request, res: Response) => {
  const pool = getPool();
  const models = await all<any>(pool, `
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `);

  // Count keys per platform
  const keyCounts = await all<{ platform: string; count: string }>(pool, `
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = true
    GROUP BY platform
  `);

  const keyCountMap = new Map(keyCounts.map(k => [k.platform, Number(k.count)]));

  const result = models.map(m => ({
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
    contextWindow: m.context_window,
    enabled: m.enabled,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled,
    hasProvider: hasProvider(m.platform),
    keyCount: keyCountMap.get(m.platform) ?? 0,
  }));

  res.json(result);
});
