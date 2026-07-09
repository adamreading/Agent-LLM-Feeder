import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/index.js';
import { get, all, run } from '../db/pgCompat.js';
import { matchModels, linkToExistingCanonical, createCanonicalFromModel } from '../services/modelCanon.js';
import { recordTaskScore, getTaskScores, TASK_TYPES } from '../services/taskScores.js';
import { researchWriterAvailable, researchCanonicalModel, recordResearch } from '../services/modelResearch.js';
import { searchConfigured } from '../services/webSearch.js';
import { startMissingResearch, getResearchStatus } from '../services/researchRunner.js';

export const canonRouter = Router();

// The model wiki's data source: every canonical model with its capability
// pill rollup (OR'd across every linked supplier instance — "does ANY
// provider offering this model support tools" is what a reader wants on a
// wiki page, per-supplier variance is the drill-down, not the headline) plus
// the list of live supplier instances underneath it.
canonRouter.get('/', async (_req, res) => {
  const pool = getPool();
  const canonicals = await all<{ id: number; name: string; slug: string; summary: string | null; vision: boolean; video: boolean; audio: boolean }>(pool, `
    SELECT id, name, slug, summary, vision, video, audio FROM canonical_models ORDER BY name ASC
  `);

  const result = [];
  for (const c of canonicals) {
    // Per-supplier instances with their live health (latency/status) LEFT-
    // joined — the wiki renders one row per supplier with a live status +
    // latency pill, so the reader sees not just "who offers this model" but
    // "which supplier is fast and healthy right now."
    const instances = await all<{
      id: number; platform: string; model_id: string; display_name: string; enabled: boolean;
      disabled_reason: string | null; context_window: number | null; size_label: string; cost_tier: string;
      intelligence_rank: number; speed_rank: number;
      rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; monthly_token_budget: string;
      recent_latency_ms: number | null; health_score: number | null; health_status: string | null;
    }>(pool, `
      SELECT m.id, m.platform, m.model_id, m.display_name, m.enabled, m.disabled_reason,
             m.context_window, m.size_label, m.cost_tier,
             m.intelligence_rank, m.speed_rank,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.monthly_token_budget,
             h.recent_latency_ms, h.health_score, h.status AS health_status
      FROM models m
      LEFT JOIN model_health h ON h.model_db_id = m.id
      WHERE m.canonical_model_id = ? AND m.enabled = true ORDER BY m.platform ASC
    `, [c.id]);

    // The wiki shows models feeder can actually serve — so a model whose only
    // suppliers are DEACTIVATED (key removed → disabled_reason='no_key',
    // manually benched, or auto-benched unreachable) drops out entirely, and a
    // deactivated supplier drops off a still-served model's list. This is why
    // removing the Ollama key removes its models from the wiki (Adam, 2026-07-09).
    if (instances.length === 0) continue;
    const capRollup = await all<{ capability: string; supported: boolean }>(pool, `
      SELECT capability, bool_or(supported) as supported
      FROM model_capabilities
      WHERE model_db_id = ANY(?::int[]) AND source = 'measured'
      GROUP BY capability
    `, [instances.map((i) => i.id)]);

    const taskScores = await all<{ task_type: string; score: number; rank: number | null; source: string }>(pool, `
      SELECT task_type, score, rank, source FROM task_scores WHERE canonical_model_id = ? ORDER BY score DESC
    `, [c.id]);

    result.push({ ...c, instances, capabilities: capRollup, taskScores });
  }

  res.json(result);
});

// Notification/badge source + the match-up review page's worklist: every
// supplier-specific row that hasn't completed matching yet. Per Adam's
// directive, these deliberately do NOT appear in GET / above — a model stays
// invisible to the wiki until a human (or the auto-match pass) resolves it.
canonRouter.get('/unmatched', async (_req, res) => {
  const pool = getPool();
  const rows = await all(pool, `
    SELECT id, platform, model_id, display_name, size_label, context_window
    FROM models WHERE canonical_model_id IS NULL ORDER BY platform ASC, model_id ASC
  `);
  res.json(rows);
});

// Candidate suggestions for the match-up page's dropdown, cheap best-effort
// substring match on name/slug — NOT the auto-match algorithm (that only
// ever exact-matches a normalized key, see modelCanon.ts). This is purely to
// shorten the list a human scrolls through; it never links anything itself.
canonRouter.get('/suggestions', async (req, res) => {
  const modelDbId = Number(req.query.model_db_id);
  if (!modelDbId) {
    res.status(400).json({ error: { message: 'model_db_id query param is required', type: 'invalid_request_error' } });
    return;
  }
  const pool = getPool();
  const model = await get<{ model_id: string; display_name: string }>(pool, 'SELECT model_id, display_name FROM models WHERE id = ?', [modelDbId]);
  if (!model) {
    res.status(404).json({ error: { message: `No models row with id ${modelDbId}`, type: 'invalid_request_error' } });
    return;
  }
  const leaf = (model.model_id.split('/').pop() ?? model.model_id).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6);
  const candidates = await all(pool, `SELECT id, name, slug FROM canonical_models WHERE lower(replace(slug, '-', '')) LIKE ? ORDER BY name ASC LIMIT 10`, [`%${leaf}%`]);
  res.json(candidates);
});

// Manually resolve one unmatched row: link to an existing canonical model.
const linkSchema = z.object({ model_db_id: z.number().int(), canonical_model_id: z.number().int() });
canonRouter.post('/match', async (req, res) => {
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: `Invalid request: ${parsed.error.errors.map((e) => e.message).join(', ')}`, type: 'invalid_request_error' } });
    return;
  }
  try {
    await linkToExistingCanonical(getPool(), parsed.data.model_db_id, parsed.data.canonical_model_id);
    res.status(200).json({ linked: true });
  } catch (err: any) {
    res.status(404).json({ error: { message: err.message, type: 'invalid_request_error' } });
  }
});

// Manually resolve one unmatched row: it's genuinely new, create its
// canonical entry (the "New" option in the match-up dropdown).
const createSchema = z.object({
  model_db_id: z.number().int(),
  name: z.string().min(1).optional(),
  summary: z.string().optional(),
  vision: z.boolean().optional(),
  video: z.boolean().optional(),
  audio: z.boolean().optional(),
});
canonRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: `Invalid request: ${parsed.error.errors.map((e) => e.message).join(', ')}`, type: 'invalid_request_error' } });
    return;
  }
  const { model_db_id, ...fields } = parsed.data;
  try {
    const canonicalId = await createCanonicalFromModel(getPool(), model_db_id, fields);
    res.status(201).json({ canonical_model_id: canonicalId });
  } catch (err: any) {
    res.status(404).json({ error: { message: err.message, type: 'invalid_request_error' } });
  }
});

// Edit a canonical model's wiki content (summary paragraph, modality flags)
// — the research cron or a human fills these in after creation; they're
// null/false by default from either auto-merge or manual "New".
const updateSchema = z.object({
  name: z.string().min(1).optional(),
  summary: z.string().optional(),
  vision: z.boolean().optional(),
  video: z.boolean().optional(),
  audio: z.boolean().optional(),
});
canonRouter.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const parsed = updateSchema.safeParse(req.body);
  if (!id || !parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request', type: 'invalid_request_error' } });
    return;
  }
  const pool = getPool();
  const existing = await get<{ id: number }>(pool, 'SELECT id FROM canonical_models WHERE id = ?', [id]);
  if (!existing) {
    res.status(404).json({ error: { message: `No canonical_models row with id ${id}`, type: 'invalid_request_error' } });
    return;
  }
  const fields = parsed.data;
  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    params.push(v);
  }
  if (sets.length === 0) {
    res.status(400).json({ error: { message: 'No fields to update', type: 'invalid_request_error' } });
    return;
  }
  sets.push('updated_at = now()');
  params.push(id);
  await run(pool, `UPDATE canonical_models SET ${sets.join(', ')} WHERE id = ?`, params);
  res.status(200).json({ updated: true });
});

// On-demand trigger for the auto-match pass, independent of a server
// restart — the natural hook point once a future dynamic per-supplier
// discovery job exists ("new supplier added -> discover its models -> call
// this"), and useful right now for testing/ops without a restart.
canonRouter.post('/run-match', async (_req, res) => {
  const result = await matchModels(getPool());
  res.status(200).json(result);
});

// The task-type taxonomy (lmarena categories) — the UI reads this to render
// score columns/filters without hardcoding the list client-side.
canonRouter.get('/task-types', (_req, res) => {
  res.json(TASK_TYPES);
});

// On-demand research trigger for a single canonical model — web research +
// writer-model synthesis → summary + task scores. Lets the UI's "research this
// model" action run without the whole-catalog script. Returns 503 if the
// web-search backend or a writer model isn't configured (see .env.example).
canonRouter.post('/:id/research', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: { message: 'invalid id', type: 'invalid_request_error' } }); return; }
  if (!searchConfigured()) {
    res.status(503).json({ error: { message: 'No web-search backend configured (set WEB_SEARCH_BACKEND + its API key).', type: 'not_configured' } });
    return;
  }
  const pool = getPool();
  if (!(await researchWriterAvailable(pool))) {
    res.status(503).json({ error: { message: 'No writer model available (add a key for a json_mode-capable model).', type: 'not_configured' } });
    return;
  }
  try {
    const result = await researchCanonicalModel(pool, id);
    await recordResearch(pool, id, result);
    res.status(200).json({ summary: result.summary, tasks: result.tasks, sources: result.sources });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message, type: 'research_error' } });
  }
});

// Wiki "RESEARCH MISSING" button: kick off a background pass over every
// canonical model that still lacks a summary. Returns immediately (the pass
// runs detached; the button polls /research-status). One pass at a time —
// re-clicking while running is a no-op with a reason. Stops cleanly on the
// search backend's hourly rate limit; re-click later to fill the rest.
canonRouter.post('/research-missing', async (_req, res) => {
  const started = await startMissingResearch(getPool());
  res.status(started.started ? 202 : 409).json(started);
});

// Progress source for the button while a pass runs (and live "remaining" count
// between passes, so the button can label itself honestly).
canonRouter.get('/research-status', async (_req, res) => {
  res.json(await getResearchStatus(getPool()));
});

// All quality scores for one canonical model (the wiki drill-down / editor).
canonRouter.get('/:id/scores', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: { message: 'invalid id', type: 'invalid_request_error' } });
    return;
  }
  res.json(await getTaskScores(getPool(), id));
});

// Record/upsert a quality score. Used by the weekly lmarena ingest (step 4)
// and available for a manual UI override. source defaults to 'benchmark'.
const scoreSchema = z.object({
  task_type: z.string().min(1),
  score: z.number().min(0).max(1),
  rank: z.number().int().optional(),
  source: z.enum(['benchmark', 'measured', 'declared']).optional(),
  evidence: z.string().max(2000).optional(),
});
canonRouter.post('/:id/scores', async (req, res) => {
  const id = Number(req.params.id);
  const parsed = scoreSchema.safeParse(req.body);
  if (!id || !parsed.success) {
    res.status(400).json({ error: { message: 'invalid request', type: 'invalid_request_error' } });
    return;
  }
  const canonical = await get<{ id: number }>(getPool(), 'SELECT id FROM canonical_models WHERE id = ?', [id]);
  if (!canonical) {
    res.status(404).json({ error: { message: `No canonical_models row with id ${id}`, type: 'invalid_request_error' } });
    return;
  }
  await recordTaskScore(getPool(), id, {
    taskType: parsed.data.task_type,
    score: parsed.data.score,
    rank: parsed.data.rank ?? null,
    source: parsed.data.source,
    evidence: parsed.data.evidence ?? null,
  });
  res.status(201).json({ recorded: true });
});
