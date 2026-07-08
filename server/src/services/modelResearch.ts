import type pg from 'pg';
import { all, get, run } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { getSearchBackend, type SearchResult } from './webSearch.js';
import { recordTaskScore, TASK_TYPES } from './taskScores.js';

// Per-model "street research" (Adam's brief): a nicely-written summary of what
// each model is actually good at, plus per-task quality scores — grounded in
// real web data (arena.ai/leaderboard + general search about the model), and
// WRITTEN by one of the fleet's own models chosen for writing/research. The
// web-search backend is pluggable (services/webSearch.ts, Ollama by default);
// the writer model is configurable (RESEARCH_MODEL) or auto-picked.
//
// Discipline (same as the capability probes): grounded, never fabricated — the
// writer is told to use ONLY the supplied sources and to null a score it can't
// support, rather than guess. Scores are source='benchmark' (external claim),
// never presented as something feeder measured on the wire.

interface WriterCtx { platform: string; modelId: string; apiKey: string }

// Pick the model that writes the summaries. RESEARCH_MODEL=platform/model_id
// overrides; otherwise auto-pick the smartest reachable, json_mode-capable,
// keyed model (good structured output + strong writing correlate with rank).
export async function getWriterModel(pool: pg.Pool): Promise<WriterCtx | null> {
  const explicit = process.env.RESEARCH_MODEL
  if (explicit && explicit.includes('/')) {
    const platform = explicit.slice(0, explicit.indexOf('/'))
    const modelId = explicit.slice(explicit.indexOf('/') + 1)
    const keyRow = await get<{ encrypted_key: string; iv: string; auth_tag: string }>(pool,
      `SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = true AND status != 'invalid' LIMIT 1`, [platform])
    if (keyRow) return { platform, modelId, apiKey: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag) }
  }
  // Auto-pick: smartest model that is (a) json_mode-capable, (b) confirmed
  // REACHABLE (both measured), (c) enabled with a live key. The reachable
  // requirement avoids picking a catalog entry whose endpoint 404s.
  const row = await get<{ platform: string; model_id: string; encrypted_key: string; iv: string; auth_tag: string }>(pool, `
    SELECT m.platform, m.model_id, k.encrypted_key, k.iv, k.auth_tag
    FROM models m
    JOIN api_keys k ON k.platform = m.platform AND k.enabled = true AND k.status != 'invalid'
    WHERE m.enabled = true
      AND EXISTS (SELECT 1 FROM model_capabilities c WHERE c.model_db_id = m.id AND c.capability = 'json_mode' AND c.supported = true AND c.source = 'measured')
      AND EXISTS (SELECT 1 FROM model_capabilities c WHERE c.model_db_id = m.id AND c.capability = 'reachable' AND c.supported = true AND c.source = 'measured')
    ORDER BY m.intelligence_rank ASC
    LIMIT 1
  `)
  if (!row) return null
  return { platform: row.platform, modelId: row.model_id, apiKey: decrypt(row.encrypted_key, row.iv, row.auth_tag) }
}

interface ResearchResult { summary: string | null; tasks: Record<string, number>; sources: string[] }

export async function researchCanonicalModel(pool: pg.Pool, canonicalId: number, writer: WriterCtx): Promise<ResearchResult> {
  const canonical = await get<{ name: string }>(pool, `SELECT name FROM canonical_models WHERE id = ?`, [canonicalId])
  if (!canonical) throw new Error(`No canonical model ${canonicalId}`)
  const name = canonical.name

  const backend = getSearchBackend()
  if (!backend.isConfigured()) throw new Error(`Web-search backend '${backend.id}' is not configured (set its API key in .env).`)

  // Two angles: general reputation + the arena leaderboard specifically.
  const queries = [
    `${name} LLM model strengths weaknesses what is it good at benchmarks`,
    `${name} lmarena arena.ai leaderboard score ranking coding math reasoning`,
  ]
  const seen = new Set<string>()
  const results: SearchResult[] = []
  for (const q of queries) {
    try {
      for (const r of await backend.search(q, 4)) {
        if (!seen.has(r.url)) { seen.add(r.url); results.push(r) }
      }
    } catch { /* one failed query shouldn't sink the pass */ }
  }
  // Fetch full text of the single most relevant result to deepen the corpus.
  let fetched = ''
  if (results[0]) { try { fetched = (await backend.fetch(results[0].url)).content.slice(0, 4000) } catch { /* snippet-only */ } }

  const corpus = [
    ...results.map(r => `[${r.url}]\n${r.title}\n${r.content}`),
    fetched ? `[full: ${results[0].url}]\n${fetched}` : '',
  ].filter(Boolean).join('\n\n---\n\n').slice(0, 14000)

  if (!corpus) return { summary: null, tasks: {}, sources: [] }

  const taskList = TASK_TYPES.join(', ')
  const prompt = `You are writing a concise, punchy reference entry about the LLM "${name}" for a developer-facing model wiki. Use ONLY the search results below — do not invent facts. Be specific about what it's genuinely good and bad at.

Respond with ONLY a JSON object of this exact shape:
{
  "summary": "2-3 sentences: what this model is, its real strengths, and what to avoid using it for. Punchy and factual.",
  "tasks": { <for any of these tasks the sources support, a 0-100 quality score>: ${taskList} }
}
Rules: omit any task the sources don't address (do not guess). If the sources say nothing useful about the model at all, return {"summary": null, "tasks": {}}.

Search results:
${corpus}`

  const provider = getProvider(writer.platform as any)
  if (!provider) throw new Error(`Writer platform ${writer.platform} has no provider`)
  const result = await provider.chatCompletion(writer.apiKey, [{ role: 'user', content: prompt }], writer.modelId, {
    max_tokens: 600,
    response_format: { type: 'json_object' },
  })
  const content = result.choices?.[0]?.message?.content
  if (typeof content !== 'string') return { summary: null, tasks: {}, sources: results.map(r => r.url) }

  let parsed: any
  try { parsed = JSON.parse(content) } catch { return { summary: null, tasks: {}, sources: results.map(r => r.url) } }

  const summary = typeof parsed.summary === 'string' && parsed.summary.trim().length > 0 ? parsed.summary.trim() : null
  const tasks: Record<string, number> = {}
  if (parsed.tasks && typeof parsed.tasks === 'object') {
    for (const [k, v] of Object.entries(parsed.tasks)) {
      const n = Number(v)
      if (TASK_TYPES.includes(k as any) && Number.isFinite(n) && n >= 0 && n <= 100) tasks[k] = n
    }
  }
  return { summary, tasks, sources: results.map(r => r.url) }
}

// Persist a research outcome: the summary paragraph + per-task benchmark
// scores (0-1 normalized), evidence pointing at the sources used.
export async function recordResearch(pool: pg.Pool, canonicalId: number, res: ResearchResult): Promise<void> {
  const evidence = res.sources.slice(0, 3).join(' ') || 'web research'
  if (res.summary) {
    await run(pool, `UPDATE canonical_models SET summary = ?, updated_at = now() WHERE id = ?`, [res.summary, canonicalId])
  }
  for (const [taskType, score] of Object.entries(res.tasks)) {
    await recordTaskScore(pool, canonicalId, { taskType, score: score / 100, source: 'benchmark', evidence })
  }
}
