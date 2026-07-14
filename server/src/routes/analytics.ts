import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPool } from '../db/index.js';
import { all, get } from '../db/pgCompat.js';

export const analyticsRouter = Router();

// Analytics counts REAL routed traffic by default — probe calls (is_probe=true)
// are excluded so the prober's exploration doesn't distort success%/latency/
// counts (the router + health code already exclude probes; analytics now matches).
// Opt back in with ?includeProbes=1. Returns one of two CONSTANT fragments (the
// query param only toggles between them), so no SQL is user-controlled.
function probeFilter(req: Request, col = 'is_probe'): string {
  return req.query.includeProbes === '1' ? '' : ` AND ${col} = false`;
}

// Map range to a JS-computed ISO timestamp passed as a bind parameter,
// so the SQL string never includes user-controlled fragments.
function getSinceTimestamp(range: string): string {
  const now = Date.now();
  switch (range) {
    case '24h':
      return new Date(now - 24 * 60 * 60 * 1000).toISOString();
    case '30d':
      return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    case '7d':
    default:
      return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
}

// Summary stats
analyticsRouter.get('/summary', async (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);

  const stats = await get<any>(getPool(), `
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      AVG(latency_ms) as avg_latency_ms
    FROM requests
    WHERE created_at >= ?${probeFilter(req)}
  `, [since]);

  const totalRequests = Number(stats.total_requests ?? 0);
  const successCount = Number(stats.success_count ?? 0);
  const totalInputTokens = Number(stats.total_input_tokens ?? 0);
  const totalOutputTokens = Number(stats.total_output_tokens ?? 0);
  const successRate = totalRequests > 0 ? (successCount / totalRequests) * 100 : 0;

  // Estimate cost savings: average ~$3/M input + $15/M output tokens (GPT-4o pricing)
  const inputCost = (totalInputTokens / 1_000_000) * 3;
  const outputCost = (totalOutputTokens / 1_000_000) * 15;

  res.json({
    totalRequests,
    successRate: Math.round(successRate * 10) / 10,
    totalInputTokens,
    totalOutputTokens,
    avgLatencyMs: Math.round(Number(stats.avg_latency_ms ?? 0)),
    estimatedCostSavings: Math.round((inputCost + outputCost) * 100) / 100,
  });
});

// Stats grouped by model
analyticsRouter.get('/by-model', async (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);

  const rows = await all<any>(getPool(), `
    SELECT
      r.platform,
      r.model_id,
      m.display_name,
      COUNT(*) as requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ?${probeFilter(req, 'r.is_probe')}
    GROUP BY r.platform, r.model_id, m.display_name
    ORDER BY requests DESC
  `, [since]);

  res.json(rows.map(r => ({
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name ?? r.model_id,
    requests: Number(r.requests),
    successRate: Math.round(Number(r.success_rate) * 10) / 10,
    avgLatencyMs: Math.round(Number(r.avg_latency_ms)),
    totalInputTokens: Number(r.total_input_tokens ?? 0),
    totalOutputTokens: Number(r.total_output_tokens ?? 0),
  })));
});

// Stats grouped by platform
analyticsRouter.get('/by-platform', async (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);

  const rows = await all<any>(getPool(), `
    SELECT
      platform,
      COUNT(*) as requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(latency_ms) as avg_latency_ms,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens
    FROM requests
    WHERE created_at >= ?${probeFilter(req)}
    GROUP BY platform
    ORDER BY requests DESC
  `, [since]);

  res.json(rows.map(r => ({
    platform: r.platform,
    requests: Number(r.requests),
    successRate: Math.round(Number(r.success_rate) * 10) / 10,
    avgLatencyMs: Math.round(Number(r.avg_latency_ms)),
    totalInputTokens: Number(r.total_input_tokens ?? 0),
    totalOutputTokens: Number(r.total_output_tokens ?? 0),
  })));
});

// Timeline data
analyticsRouter.get('/timeline', async (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const interval = (req.query.interval as string) ?? (range === '24h' ? 'hour' : 'day');
  const since = getSinceTimestamp(range);

  // dateFormat is a hardcoded whitelist — never user-controlled.
  const dateFormat = interval === 'hour' ? 'YYYY-MM-DD"T"HH24:00:00' : 'YYYY-MM-DD';

  const rows = await all<any>(getPool(), `
    SELECT
      to_char(created_at, '${dateFormat}') as timestamp,
      COUNT(*) as requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failure_count
    FROM requests
    WHERE created_at >= ?${probeFilter(req)}
    GROUP BY to_char(created_at, '${dateFormat}')
    ORDER BY timestamp ASC
  `, [since]);

  res.json(rows.map(r => ({
    timestamp: r.timestamp,
    requests: Number(r.requests),
    successCount: Number(r.success_count),
    failureCount: Number(r.failure_count),
  })));
});

// Error distribution (grouped by error type and platform)
analyticsRouter.get('/error-distribution', async (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const pool = getPool();

  // Group errors by category (extract the key part of the error message)
  const rows = await all<any>(pool, `
    SELECT
      platform,
      model_id,
      CASE
        WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
        WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
        WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
        WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as error_category,
      COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?${probeFilter(req)}
    GROUP BY platform, model_id, error_category
    ORDER BY count DESC
  `, [since]);

  // Also get totals by category
  const byCategory = await all<any>(pool, `
    SELECT
      CASE
        WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
        WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
        WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
        WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as category,
      COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?${probeFilter(req)}
    GROUP BY category
    ORDER BY count DESC
  `, [since]);

  // Errors by platform
  const byPlatform = await all<any>(pool, `
    SELECT platform, COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?${probeFilter(req)}
    GROUP BY platform
    ORDER BY count DESC
  `, [since]);

  res.json({
    byCategory: byCategory.map(r => ({ category: r.category, count: Number(r.count) })),
    byPlatform: byPlatform.map(r => ({ platform: r.platform, count: Number(r.count) })),
    detailed: rows.map(r => ({ platform: r.platform, model_id: r.model_id, error_category: r.error_category, count: Number(r.count) })),
  });
});

// Recent errors
analyticsRouter.get('/errors', async (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);

  const rows = await all<any>(getPool(), `
    SELECT id, platform, model_id, error, latency_ms, created_at
    FROM requests
    WHERE status = 'error' AND created_at >= ?${probeFilter(req)}
    ORDER BY created_at DESC
    LIMIT 50
  `, [since]);

  res.json(rows.map(r => ({
    id: r.id,
    platform: r.platform,
    modelId: r.model_id,
    error: r.error,
    latencyMs: r.latency_ms,
    createdAt: r.created_at,
  })));
});
