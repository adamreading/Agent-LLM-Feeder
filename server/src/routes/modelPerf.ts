import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getPool } from '../db/index.js';
import { recordRealtimeQuality } from '../services/modelPerf.js';

export const modelPerfRouter = Router();

// Real-usage quality ingestion endpoint (Adam, 2026-07-10). The fleet's
// answer-evaluation capture posts a per-model quality judgement here; feeder
// folds it into task_scores (source='realtime_quality'), which drives both the
// Model Wiki rating and routing's taskQuality. Sampled, not per-turn (bias +
// token/latency cost) — the caller decides sampling; feeder just ingests.
const sampleSchema = z.object({
  model_id: z.string().min(1),          // platform/model_id, bare model_id, or canonical slug
  task_class: z.string().optional(),    // caller task_class → mapped to arena task_type, same as routing
  quality_score: z.number().min(0).max(1),
  judge: z.string().optional(),         // judge model / signal source (recorded as evidence)
  session_ref: z.string().optional(),   // optional attribution ref (not stored yet; reserved)
});

modelPerfRouter.post('/sample', async (req: Request, res: Response) => {
  const parsed = sampleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: `Invalid sample: ${parsed.error.errors.map(e => e.message).join(', ')}` } });
    return;
  }
  const { model_id, task_class, quality_score, judge } = parsed.data;
  const result = await recordRealtimeQuality(getPool(), {
    modelRef: model_id, taskClass: task_class ?? null, qualityScore: quality_score, judge: judge ?? null,
  });
  if (!result.ok) {
    // A model we can't resolve is a 404 (bad ref), a bad score is a 400 —
    // both distinguishable by the reason string; never silently accept.
    res.status(result.reason?.startsWith('no canonical') ? 404 : 400).json({ error: { message: result.reason } });
    return;
  }
  res.json({ ok: true, canonical_model_id: result.canonicalId, task_type: result.taskType, score: result.newScore });
});
