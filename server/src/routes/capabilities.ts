import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/index.js';
import { get, run, all } from '../db/pgCompat.js';

export const capabilitiesRouter = Router();

// Generic capability-reporting endpoint — lets an EXTERNAL caller (any
// policy-aware consumer or agent) report a real measured capability fact for
// a model it identifies by platform+model_id, without feeder needing to know
// what the capability name MEANS or run the test itself. feeder stays a
// generic, use-case-agnostic provider — a consumer-specific probe (e.g. one
// that tests whether a model can drive that consumer's own private tool/API)
// is consumer policy and belongs in the consumer's own codebase, calling this
// endpoint to populate feeder's generic capability table rather than living in
// feeder's core (see services/probes/methods.ts's tools/json_mode/
// long_context probes, which stay in feeder because they test feeder's own
// job — talking to the LLM providers it routes to — not a third-party
// system's API).
//
// source is always 'measured' here — an external caller reporting this is
// making the same epistemic claim feeder's own probes make ("I actually
// tested this on the wire"), not a 'declared' web-search-sourced guess.
// The router's hard safety gates (router.ts) only ever trust 'measured'
// rows for exactly this reason.
const reportSchema = z.object({
  platform: z.string().min(1),
  model_id: z.string().min(1),
  capability: z.string().min(1),
  supported: z.boolean(),
  evidence: z.string().max(2000).optional(),
});

capabilitiesRouter.post('/', async (req, res) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map((e) => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const { platform, model_id, capability, supported, evidence } = parsed.data;
  const pool = getPool();

  const model = await get<{ id: number }>(pool, `SELECT id FROM models WHERE platform = ? AND model_id = ?`, [platform, model_id]);
  if (!model) {
    res.status(404).json({
      error: {
        message: `No model found for platform='${platform}' model_id='${model_id}'`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  await run(pool, `
    INSERT INTO model_capabilities (model_db_id, capability, supported, source, measured_at, evidence)
    VALUES (?, ?, ?, 'measured', now(), ?)
    ON CONFLICT (model_db_id, capability, source)
    DO UPDATE SET supported = EXCLUDED.supported, measured_at = now(), evidence = EXCLUDED.evidence, suspect = false
  `, [model.id, capability, supported, evidence ?? null]);

  res.status(201).json({ platform, model_id, capability, supported });
});

// Read-side: let a caller check what's already measured for a model before
// deciding whether to re-run its own probe.
capabilitiesRouter.get('/', async (req, res) => {
  const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;
  const modelId = typeof req.query.model_id === 'string' ? req.query.model_id : undefined;
  const pool = getPool();

  if (platform && modelId) {
    const model = await get<{ id: number }>(pool, `SELECT id FROM models WHERE platform = ? AND model_id = ?`, [platform, modelId]);
    if (!model) {
      res.status(404).json({ error: { message: `No model found for platform='${platform}' model_id='${modelId}'`, type: 'invalid_request_error' } });
      return;
    }
    const rows = await all(pool, `SELECT capability, supported, source, measured_at, evidence FROM model_capabilities WHERE model_db_id = ?`, [model.id]);
    res.json({ platform, model_id: modelId, capabilities: rows });
    return;
  }

  res.status(400).json({ error: { message: 'platform and model_id query params are required', type: 'invalid_request_error' } });
});
