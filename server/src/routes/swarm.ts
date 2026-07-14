import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPool } from '../db/index.js';
import { all } from '../db/pgCompat.js';
import { taskTypeFor } from '../services/router.js';
import { heldPlatforms } from '../services/swarmLanes.js';

// Swarm-allocation support for parallel task-runners (RINGER). Read-only.
export const swarmRouter = Router();

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
