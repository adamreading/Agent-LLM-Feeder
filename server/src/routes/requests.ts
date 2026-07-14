import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getPool } from '../db/index.js';
import { all } from '../db/pgCompat.js';

// Read-only per-request telemetry — the served-model / failover / latency /
// token view that a caller (e.g. RINGER's Ringside) can't reconstruct itself
// because OpenCode swallows the response model. Filter by consumer and/or
// session_id and/or a since-timestamp; returns the most-recent matching rows in
// chronological order (oldest→newest) so a worker's call sequence reads top-down.
export const requestsRouter = Router();

const querySchema = z.object({
  consumer: z.string().max(64).optional(),
  session_id: z.string().max(128).optional(),
  since: z.string().datetime().optional(),   // ISO-8601, e.g. 2026-07-14T12:50:00Z
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

requestsRouter.get('/', async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { message: `Invalid query: ${parsed.error.errors.map(e => e.message).join(', ')}` } });
    return;
  }
  const { consumer, session_id, since, limit } = parsed.data;

  const filters: string[] = [];
  const params: unknown[] = [];
  if (consumer) { filters.push('consumer = ?'); params.push(consumer); }
  if (session_id) { filters.push('session_id = ?'); params.push(session_id); }
  if (since) { filters.push('created_at >= ?'); params.push(since); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const lim = limit ?? 200;

  // DESC + reverse → the most-recent window, presented chronologically.
  const rows = await all<any>(getPool(), `
    SELECT id, created_at, platform, model_id, status, task_class, consumer,
           session_id, latency_ms, input_tokens, output_tokens, error, is_probe, augmented
    FROM requests
    ${where}
    ORDER BY id DESC
    LIMIT ${lim}
  `, params);

  rows.reverse();
  res.json(rows.map(r => ({ ...r, served_model: `${r.platform}/${r.model_id}` })));
});
