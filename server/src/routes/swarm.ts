import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPool } from '../db/index.js';
import { all } from '../db/pgCompat.js';
import { taskTypeFor } from '../services/router.js';
import { heldPlatforms } from '../services/swarmLanes.js';
import { declareBudget, peekBudget } from '../services/swarmBudget.js';

// Swarm-allocation support for parallel task-runners (RINGER). Read-only EXCEPT
// POST /budget (declares a run's spend ceiling — localhost/dispatch-only).
export const swarmRouter = Router();

function isLocalReq(req: Request): boolean {
  return req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
}

// GET /api/swarm/capacity?class=<wire_class>  ->  { sessions, class, task_type }
//
// `sessions` = how many DISTINCT provider lanes can serve a chat request RIGHT
// NOW. A "lane" = a platform with >=1 enabled, chat-kind model that has a
// healthy configured key and is not quota-parked or cooling. This is the
// distinct-provider CEILING for a swarm: with hard provider anti-affinity (at
// most one worker per platform), N concurrent workers need N lanes — so a
// caller sets --max-parallel = min(manifest.max_parallel, sessions) and
// re-queries per round. As providers quota-park, the number shrinks, which is
// the swarm's backpressure signal (closes the loop without guessing TPM/RPD).
//
// task_class is ORDERING-ONLY in the router (never a hard capability filter),
// so eligibility — hence this count — is class-independent. The `class` param
// is accepted for a stable call shape + future quality-aware refinement, and is
// echoed back with its mapped arena task_type. v1 returns TOTAL healthy lanes;
// subtracts lanes currently held by an active sibling swarm session, so
// `sessions` is FREE lanes and overlapping runs can't over-subscribe. At launch
// (no active sessions) FREE == TOTAL.
swarmRouter.get('/capacity', async (req: Request, res: Response) => {
  const wireClass = typeof req.query.class === 'string' ? req.query.class : null;
  const taskType = taskTypeFor(wireClass);

  // Distinct platforms with >=1 enabled chat model that has a healthy key and
  // is not quota-parked/cooling right now.
  const rows = await all<{ platform: string }>(getPool(), `
    SELECT DISTINCT m.platform
    FROM models m
    WHERE m.enabled = true AND m.kind = 'chat'
      AND EXISTS (
        SELECT 1 FROM api_keys k
        WHERE k.platform = m.platform AND k.enabled = true AND k.status <> 'invalid'
      )
      AND NOT EXISTS (
        SELECT 1 FROM model_health h
        WHERE h.model_db_id = m.id
          AND ((h.cooldown_until IS NOT NULL AND h.cooldown_until > now())
            OR (h.quota_exhausted_until IS NOT NULL AND h.quota_exhausted_until > now()))
      )
  `, []);

  // FREE lanes = healthy lanes minus those held by an active sibling session.
  const held = heldPlatforms();
  const free = rows.filter(r => !held.has(r.platform)).length;

  res.json({ sessions: free, class: wireClass, task_type: taskType });
});

// POST /api/swarm/budget  { run_id, max_tokens, consumer? }  ->  { run_id, consumer, budget, spent }
//
// Declares a per-RUN cumulative token ceiling that feeder ENFORCES at the /v1
// choke point: once (consumer, run_id) input+output tokens cross max_tokens,
// further calls for that run are refused pre-route with a terminal 429
// `run_budget_exceeded` (see services/swarmBudget.ts + the enforcer in
// proxy.ts). The run id is carried on the wire as the `X-Run-Id` header.
//
// Contract (locked with ringer 2026-07-15):
//  • Called ONCE by the DISPATCH layer at run start (ringer at claim) — NOT by
//    workers. LOCALHOST-ONLY (the operator's own machine), matching /api/agent.
//  • SET-ONCE + LOWER-ONLY: a second call for the same run may only REDUCE the
//    ceiling, never raise it — so neither orchestrator nor worker can uncap
//    mid-run. Enforced in declareBudget.
//  • OPT-IN: a run with no declared budget is unlimited (today's behaviour).
//  • consumer defaults to 'ringer' (the sole swarm consumer today); the pair
//    (consumer, run_id) is the metering key, matching anti-affinity grouping.
swarmRouter.post('/budget', async (req: Request, res: Response) => {
  if (!isLocalReq(req)) {
    res.status(403).json({ error: { message: 'POST /api/swarm/budget is localhost-only (dispatch layer)', type: 'forbidden' } });
    return;
  }
  const body = (req.body ?? {}) as { run_id?: unknown; max_tokens?: unknown; consumer?: unknown };
  const runId = typeof body.run_id === 'string' ? body.run_id.trim() : '';
  const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : Number(body.max_tokens);
  const consumer = typeof body.consumer === 'string' && body.consumer.trim() ? body.consumer.trim() : 'ringer';
  if (!runId) {
    res.status(400).json({ error: { message: 'run_id (non-empty string) is required', type: 'invalid_request_error' } });
    return;
  }
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    res.status(400).json({ error: { message: 'max_tokens (positive number) is required', type: 'invalid_request_error' } });
    return;
  }
  const { budget, spent } = await declareBudget(getPool(), consumer, runId, Math.floor(maxTokens));
  res.json({ run_id: runId, consumer, budget, spent });
});

// GET /api/swarm/budget?run_id=&consumer=  ->  { run_id, consumer, budget, spent } | 404
// Inspect a run's live budget state (metering read-out for the wall / probes).
swarmRouter.get('/budget', (req: Request, res: Response) => {
  const runId = typeof req.query.run_id === 'string' ? req.query.run_id : '';
  const consumer = typeof req.query.consumer === 'string' && req.query.consumer ? req.query.consumer : 'ringer';
  if (!runId) {
    res.status(400).json({ error: { message: 'run_id query param is required', type: 'invalid_request_error' } });
    return;
  }
  const state = peekBudget(consumer, runId);
  if (!state) {
    res.status(404).json({ error: { message: `no declared budget for run '${runId}' (consumer '${consumer}')`, type: 'not_found' } });
    return;
  }
  res.json({ run_id: runId, consumer, ...state });
});
