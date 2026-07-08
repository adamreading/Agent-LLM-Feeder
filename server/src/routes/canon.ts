import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/index.js';
import { get, all, run } from '../db/pgCompat.js';
import { matchModels, linkToExistingCanonical, createCanonicalFromModel } from '../services/modelCanon.js';

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
    const instances = await all<{ id: number; platform: string; model_id: string; display_name: string; enabled: boolean }>(pool, `
      SELECT id, platform, model_id, display_name, enabled FROM models WHERE canonical_model_id = ? ORDER BY platform ASC
    `, [c.id]);
    const capRollup = await all<{ capability: string; supported: boolean }>(pool, `
      SELECT capability, bool_or(supported) as supported
      FROM model_capabilities
      WHERE model_db_id = ANY(?::int[]) AND source = 'measured'
      GROUP BY capability
    `, [instances.map((i) => i.id)]);

    result.push({ ...c, instances, capabilities: capRollup });
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
