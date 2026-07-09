import type pg from 'pg';
import { all, get, run } from '../db/pgCompat.js';
import { getSearchBackend, type SearchResult } from './webSearch.js';
import { recordTaskScore, TASK_TYPES } from './taskScores.js';
import { routedChat } from './routedCompletion.js';

// Per-model "street research" (Adam's brief): a nicely-written summary of what
// each model is actually good at, plus per-task quality scores — grounded in
// real web data (arena.ai/leaderboard + general search about the model), and
// WRITTEN by one of the fleet's own models — chosen DYNAMICALLY by feeder's own
// router (routedChat, task 'research', needs json_mode), so it always uses the
// best available writer and fails over across the pool. The web-search backend
// is pluggable (services/webSearch.ts, Tavily/DDG/Ollama).
//
// Discipline (same as the capability probes): grounded, never fabricated — the
// writer is told to use ONLY the supplied sources and to null a score it can't
// support, rather than guess. Scores are source='benchmark' (external claim),
// never presented as something feeder measured on the wire.

// Is a research writer available at all? The writer now routes through feeder's
// own router (routedChat, task 'research', needs json_mode), so "available"
// just means the catalog has an enabled, keyed, json_mode-capable model the
// router could pick. Used as a cheap gate by the routes/runner before spending
// a search call. RESEARCH_MODEL is no longer a pin — routing chooses the best
// AVAILABLE writer dynamically and fails over across the pool (Adam's call).
export async function researchWriterAvailable(pool: pg.Pool): Promise<boolean> {
  const row = await get<{ id: number }>(pool, `
    SELECT m.id
    FROM models m
    JOIN api_keys k ON k.platform = m.platform AND k.enabled = true AND k.status != 'invalid'
    WHERE m.enabled = true
      AND EXISTS (SELECT 1 FROM model_capabilities c WHERE c.model_db_id = m.id AND c.capability = 'json_mode' AND c.supported = true AND c.source = 'measured')
    LIMIT 1
  `)
  return !!row
}

interface Modalities { vision: boolean | null; audio: boolean | null; video: boolean | null }
interface ResearchResult { summary: string | null; tasks: Record<string, number>; modalities: Modalities; sources: string[] }

// Robust JSON extraction — not every writer honors response_format cleanly:
// some wrap the object in ```json fences or add a preamble. Try a direct
// parse, then a fenced parse, then the first {...last} substring.
function parseLooseJson(text: string): any | null {
  const attempts = [text]
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) attempts.push(fence[1])
  const first = text.indexOf('{'), last = text.lastIndexOf('}')
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1))
  for (const a of attempts) {
    try { const v = JSON.parse(a.trim()); if (v && typeof v === 'object') return v } catch { /* next */ }
  }
  return null
}

export async function researchCanonicalModel(pool: pg.Pool, canonicalId: number): Promise<ResearchResult> {
  const canonical = await get<{ name: string; slug: string }>(pool, `SELECT name, slug FROM canonical_models WHERE id = ?`, [canonicalId])
  if (!canonical) throw new Error(`No canonical model ${canonicalId}`)
  const name = canonical.name
  // The slug is the hyphenated id form (e.g. "gpt-oss-120b") — it searches far
  // better than the space-mangled display name ("gpt oss 120b"), so use it as
  // the primary search term with the display name as extra context.
  const term = (canonical.slug || name).replace(/:free$/, '')

  const backend = getSearchBackend()
  if (!backend.isConfigured()) throw new Error(`Web-search backend '${backend.id}' is not configured (set its API key in .env).`)

  // ONE combined query per model. A SEARCH-backend rate-limit is tagged
  // (isSearchError) and rethrown so the runner can stop cleanly rather than
  // churn through the catalog marking everything "no data" — but a WRITER
  // model 429 (below) is NOT a search error and must only skip that one model.
  let results: SearchResult[]
  try {
    results = await backend.search(
      `${term} LLM model strengths weaknesses what it is good at benchmarks arena leaderboard`, 6,
    )
  } catch (err: any) {
    throw Object.assign(new Error(`search backend '${backend.id}': ${err?.message ?? err}`), { isSearchError: true })
  }
  // Fetch full text of the single most relevant result to deepen the corpus.
  let fetched = ''
  if (results[0]) { try { fetched = (await backend.fetch(results[0].url)).content.slice(0, 4000) } catch { /* snippet-only */ } }

  const corpus = [
    ...results.map(r => `[${r.url}]\n${r.title}\n${r.content}`),
    fetched ? `[full: ${results[0].url}]\n${fetched}` : '',
  ].filter(Boolean).join('\n\n---\n\n').slice(0, 14000)

  const noModalities: Modalities = { vision: null, audio: null, video: null }
  if (!corpus) return { summary: null, tasks: {}, modalities: noModalities, sources: [] }

  const taskList = TASK_TYPES.join(', ')
  const prompt = `You are writing a concise, punchy reference entry about the LLM "${name}" for a developer-facing model wiki. Use ONLY the search results below — do not invent facts. Be specific about what it's genuinely good and bad at.

Respond with ONLY a JSON object of this exact shape:
{
  "summary": "2-3 sentences: what this model is, its real strengths, and what to avoid using it for. Punchy and factual.",
  "tasks": { <for any of these tasks the sources support, a 0-100 quality score>: ${taskList} },
  "vision": <true if the sources say it accepts IMAGE input, false if they say it's text-only, null if unclear>,
  "audio": <true if it accepts audio input, false if not, null if unclear>,
  "video": <true if it accepts video input, false if not, null if unclear>
}
Rules: omit any task the sources don't address (do not guess). For vision/audio/video answer ONLY from the sources — use null when the sources don't clearly say. If the sources say nothing useful about the model at all, return {"summary": null, "tasks": {}, "vision": null, "audio": null, "video": null}.

Search results:
${corpus}`

  // The writer routes through feeder's OWN router as `auto/research` (Adam's
  // call): no single pinned model that stalls when it rate-limits — it fails
  // over across the pool and always uses the best AVAILABLE writer, scored on
  // instruction-following (must honor the JSON schema) and filtered to
  // json_mode-capable providers. exclude_reasoning keeps raw CoT out of the JSON.
  const routed = await routedChat([{ role: 'user', content: prompt }], {
    taskClass: 'research',
    needs: ['json_mode'],
    responseFormat: { type: 'json_object' },
    excludeReasoning: true,
    maxTokens: 600,
    maxAttempts: 6,
  })
  const content = routed?.content
  if (typeof content !== 'string') return { summary: null, tasks: {}, modalities: noModalities, sources: results.map(r => r.url) }

  const parsed = parseLooseJson(content)
  if (!parsed) return { summary: null, tasks: {}, modalities: noModalities, sources: results.map(r => r.url) }

  const summary = typeof parsed.summary === 'string' && parsed.summary.trim().length > 0 ? parsed.summary.trim() : null
  const tasks: Record<string, number> = {}
  if (parsed.tasks && typeof parsed.tasks === 'object') {
    for (const [k, v] of Object.entries(parsed.tasks)) {
      const n = Number(v)
      if (TASK_TYPES.includes(k as any) && Number.isFinite(n) && n >= 0 && n <= 100) tasks[k] = n
    }
  }
  const bool = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null)
  const modalities: Modalities = { vision: bool(parsed.vision), audio: bool(parsed.audio), video: bool(parsed.video) }
  return { summary, tasks, modalities, sources: results.map(r => r.url) }
}

// Persist a research outcome: the summary paragraph + per-task benchmark
// scores (0-1 normalized) + web-DECLARED modality flags (vision/audio/video),
// evidence pointing at the sources used.
export async function recordResearch(pool: pg.Pool, canonicalId: number, res: ResearchResult): Promise<void> {
  const evidence = res.sources.slice(0, 3).join(' ') || 'web research'
  if (res.summary) {
    await run(pool, `UPDATE canonical_models SET summary = ?, updated_at = now() WHERE id = ?`, [res.summary, canonicalId])
  }
  for (const [taskType, score] of Object.entries(res.tasks)) {
    await recordTaskScore(pool, canonicalId, { taskType, score: score / 100, source: 'benchmark', evidence })
  }
  // Modality flags: web-DECLARED capability discovery (Adam's "fast vision
  // discovery without burning tokens"). Only overwrite a column when research
  // has a definite true/false — never clobber an existing value with null.
  // These are the wiki's modality flags; they are NOT the measured hard gate
  // (a caller needing guaranteed vision still requires a probe-measured row).
  const sets: string[] = []; const params: any[] = []
  for (const [col, val] of [['vision', res.modalities.vision], ['audio', res.modalities.audio], ['video', res.modalities.video]] as const) {
    if (val !== null) { sets.push(`${col} = ?`); params.push(val) }
  }
  if (sets.length) {
    params.push(canonicalId)
    await run(pool, `UPDATE canonical_models SET ${sets.join(', ')}, updated_at = now() WHERE id = ?`, params)
  }
}
