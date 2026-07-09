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

export async function researchCanonicalModel(pool: pg.Pool, canonicalId: number, writer: WriterCtx): Promise<ResearchResult> {
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

  const provider = getProvider(writer.platform as any)
  if (!provider) throw new Error(`Writer platform ${writer.platform} has no provider`)
  // The writer is a rate-limited provider like any other (nvidia mistral-large-3
  // is 40 rpm) — retry its 429s/timeouts with backoff so a transient limit skips
  // nothing. This error is deliberately NOT tagged isSearchError: if it exhausts
  // retries the model is skipped, but the whole run does NOT stop.
  let result: Awaited<ReturnType<typeof provider.chatCompletion>> | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      result = await provider.chatCompletion(writer.apiKey, [{ role: 'user', content: prompt }], writer.modelId, {
        max_tokens: 600,
        response_format: { type: 'json_object' },
      })
      break
    } catch (err: any) {
      const msg = err?.message ?? ''
      if (attempt < 3 && /429|too many|rate.?limit|aborted|timeout|ETIMEDOUT|ECONNRESET/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)))
        continue
      }
      throw err
    }
  }
  if (!result) return { summary: null, tasks: {}, modalities: noModalities, sources: results.map(r => r.url) }
  const content = result.choices?.[0]?.message?.content
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
