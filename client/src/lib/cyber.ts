// Shared helpers + constants for the AGENT//FEEDER cyberpunk pages.

// One colour per supplier — consistent everywhere a platform appears.
export const platformColors: Record<string, string> = {
  google: '#4285f4', groq: '#f55036', cerebras: '#8b5cf6', sambanova: '#14b8a6',
  nvidia: '#76b900', mistral: '#f59e0b', openrouter: '#ec4899', github: '#6e7b8b',
  cohere: '#d946ef', cloudflare: '#f38020', zhipu: '#06b6d4', ollama: '#c9c9d6',
  kilo: '#7c3aed', pollinations: '#a855f7', llm7: '#0ea5e9', opencode: '#22c55e',
  gmi: '#00b4d8', hetzner: '#d50c2d',
}
export const platformColor = (p: string) => platformColors[p] ?? '#94a3b8'

// Display names + the canonical platform list (matches the server's PLATFORMS
// enum in routes/keys.ts) for the Key Vault add-key select and group headers.
export const PLATFORM_NAMES: Record<string, string> = {
  google: 'Google AI Studio', groq: 'Groq', cerebras: 'Cerebras', sambanova: 'SambaNova',
  nvidia: 'NVIDIA NIM', mistral: 'Mistral', openrouter: 'OpenRouter', github: 'GitHub Models',
  cohere: 'Cohere', cloudflare: 'Cloudflare Workers AI', zhipu: 'Z.ai / Zhipu', ollama: 'Ollama Cloud',
  kilo: 'Kilo Gateway', pollinations: 'Pollinations', llm7: 'LLM7', opencode: 'OpenCode Zen',
  gmi: 'GMI Cloud', hetzner: 'Hetzner Inference',
}
export const PLATFORM_IDS = Object.keys(PLATFORM_NAMES)
export const platformName = (p: string) => PLATFORM_NAMES[p] ?? p

// Friendly short labels for measured capabilities (DB capability name → chip).
export const CAP_LABELS: Record<string, string> = {
  tools: 'TOOL CALLS',
  json_mode: 'JSON MODE',
  long_context: 'LONG CTX',
  vision: 'VISION IN',
  video: 'VIDEO IN',
  audio: 'AUDIO IN',
  reasoning_control: 'REASONING',
  reachable: 'REACHABLE',
}

// Any capability without an explicit label above renders generically — feeder
// is capability-agnostic, so a caller-declared capability (whatever it is)
// still shows a sensible chip without the UI hardcoding knowledge of it.
export const capLabel = (cap: string) => CAP_LABELS[cap] ?? cap.replace(/_/g, ' ').toUpperCase()

// Task-type labels for the lmarena score bars (matches TASK_TYPES on the server).
export const TASK_LABELS: Record<string, string> = {
  overall: 'OVERALL',
  coding: 'CODING',
  math: 'MATH',
  reasoning: 'REASONING',
  creative_writing: 'CREATIVE WRITING',
  instruction_following: 'INSTRUCTION FOLLOW',
  long_query: 'LONG QUERY',
  multi_turn: 'MULTI-TURN',
}

// The catalog stores no "maker" field; infer it from the model name for the
// wiki's byline. Purely cosmetic — falls back to '—' when unknown.
const MAKER_RULES: [RegExp, string][] = [
  [/llama|scout|maverick/i, 'Meta'],
  [/gemini|gemma/i, 'Google'],
  [/mistral|codestral|magistral|devstral|ministral/i, 'Mistral'],
  [/qwen/i, 'Alibaba'],
  [/gpt-?oss/i, 'OpenAI (open)'],
  [/deepseek/i, 'DeepSeek'],
  [/kimi|moonshot/i, 'Moonshot'],
  [/glm|zhipu|z-?ai/i, 'Z.ai / Zhipu'],
  [/nemotron|minitron/i, 'NVIDIA'],
  [/minimax/i, 'MiniMax'],
  [/command/i, 'Cohere'],
  [/phi-/i, 'Microsoft'],
  [/ling/i, 'InclusionAI'],
  [/laguna|poolside/i, 'Poolside'],
  [/hy3|hunyuan|tencent/i, 'Tencent'],
  [/lfm|liquid/i, 'Liquid AI'],
]
export function makerFromName(name: string): string {
  for (const [re, maker] of MAKER_RULES) if (re.test(name)) return maker
  return '—'
}

export function prettyCtx(n: number | null | undefined): string {
  if (!n) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

export function prettyLatency(ms: number | null | undefined): string {
  if (ms == null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

// Latency → colour band (matches the design's good/warn/bad thresholds).
export function latencyColor(ms: number | null | undefined): string {
  if (ms == null) return 'var(--dim)'
  if (ms < 800) return 'var(--good)'
  if (ms < 2200) return 'var(--warn)'
  return 'var(--bad)'
}

// ── Shared API types (GET /api/canon) ──
export interface CanonInstance {
  id: number
  platform: string
  model_id: string
  display_name: string
  enabled: boolean
  disabled_reason: string | null
  context_window: number | null
  size_label: string
  cost_tier: string
  params_b: number | null
  intelligence_rank: number
  speed_rank: number
  rpm_limit: number | null
  rpd_limit: number | null
  tpm_limit: number | null
  monthly_token_budget: string
  recent_latency_ms: number | null
  health_score: number | null
  health_status: string | null
}
export interface CanonCapability { capability: string; supported: boolean }
export interface CanonTaskScore { task_type: string; score: number; rank: number | null; source: string }
export interface CanonModel {
  id: number
  name: string
  slug: string
  summary: string | null
  vision: boolean
  video: boolean
  audio: boolean
  instances: CanonInstance[]
  capabilities: CanonCapability[]
  taskScores: CanonTaskScore[]
}

// Best (lowest) intelligence/speed rank across a model's instances, and the
// widest context any supplier offers — the canonical headline figures.
export function bestIntel(m: CanonModel): number | null {
  const rs = m.instances.map(i => i.intelligence_rank).filter(n => n != null)
  return rs.length ? Math.min(...rs) : null
}
export function bestSpeed(m: CanonModel): number | null {
  const rs = m.instances.map(i => i.speed_rank).filter(n => n != null)
  return rs.length ? Math.min(...rs) : null
}
export function maxCtx(m: CanonModel): number | null {
  const cs = m.instances.map(i => i.context_window).filter((n): n is number => n != null)
  return cs.length ? Math.max(...cs) : null
}
export function fastestLatency(m: CanonModel): number | null {
  const ls = m.instances.map(i => i.recent_latency_ms).filter((n): n is number => n != null)
  return ls.length ? Math.min(...ls) : null
}
export const supportedCaps = (m: CanonModel) =>
  m.capabilities.filter(c => c.supported && !c.capability.startsWith('best_use_') && c.capability !== 'reachable')

// Research-DECLARED input modalities (vision/audio/video) live on the canonical
// row (from the street-research pass), NOT in the measured `capabilities` rollup
// — so without this they never surface on the wiki even when 19 models have
// vision=true (Adam, 2026-07-11). Marked `declared:true` so the card can render
// them distinctly from wire-MEASURED capabilities.
export const declaredModalities = (m: CanonModel): string[] => {
  const out: string[] = []
  if (m.vision) out.push('vision')
  if (m.audio) out.push('audio')
  if (m.video) out.push('video')
  return out
}
// Combined capability chips for the wiki: measured caps first, then any declared
// modality not already measured. Deduped.
export const wikiCaps = (m: CanonModel): { cap: string; declared: boolean }[] => {
  const measured = supportedCaps(m).map(c => c.capability)
  const seen = new Set(measured)
  const out: { cap: string; declared: boolean }[] = measured.map(cap => ({ cap, declared: false }))
  for (const md of declaredModalities(m)) if (!seen.has(md)) { seen.add(md); out.push({ cap: md, declared: true }) }
  return out
}
// True if a model has an input modality either measured or research-declared —
// used by the wiki filter so VISION/AUDIO/VIDEO filters find declared ones too.
export const hasModality = (m: CanonModel, cap: 'vision' | 'audio' | 'video'): boolean =>
  !!m[cap] || m.capabilities.some(c => c.capability === cap && c.supported)
export const overallScore = (m: CanonModel) =>
  m.taskScores.find(s => s.task_type === 'overall')?.score ?? null

// Size/capability weighting (mirrors SIZE_QUALITY_FACTOR in server router.ts):
// a big model with a given arena score is genuinely better than a small one
// with the same score, so the wiki RATING tilts by size — matching how routing
// weights the arena lift (Adam, 2026-07-10). Unknown bucket → neutral 0.75.
const SIZE_QUALITY_FACTOR: Record<string, number> = { frontier: 1.0, large: 0.9, medium: 0.8, small: 0.7 }
const sizeFactorOf = (label: string | null | undefined) =>
  label ? (SIZE_QUALITY_FACTOR[label.trim().toLowerCase()] ?? 0.85) : 0.85
// A canonical model's size = its strongest instance bucket (the best supplier
// offering it), since quality is a property of the weights.
export const canonSizeFactor = (m: CanonModel): number =>
  m.instances.length ? Math.max(...m.instances.map(i => sizeFactorOf(i.size_label))) : 0.75

// How much real-usage quality pulls the displayed rating off the benchmark
// prior — mirrors REALTIME_QUALITY_BLEND in the server router so the wiki shows
// the same evolving number routing uses.
const REALTIME_QUALITY_BLEND = 0.4

// Blend priors + realtime_quality for one task_type (mirrors blendTaskScores on
// the server, 2026-09-12): a LEADERBOARD prior (arena/AA, averaged) wins over the
// web-research ESTIMATE; realtime_quality blends over whichever exists. Returns
// null if nothing has a row.
export const blendedTaskScore = (m: CanonModel, taskType: string): number | null => {
  const rows = m.taskScores.filter(s => s.task_type === taskType)
  if (!rows.length) return null
  const lbs = rows.filter(s => s.source.startsWith('leaderboard')).map(s => s.score)
  const lb = lbs.length ? lbs.reduce((a, b) => a + b, 0) / lbs.length : null
  const research = rows.find(s => s.source === 'research_estimate' || s.source === 'benchmark')?.score ?? null
  const realtime = rows.find(s => s.source === 'realtime_quality')?.score ?? null
  const prior = lb ?? research
  if (prior != null && realtime != null) return prior * (1 - REALTIME_QUALITY_BLEND) + realtime * REALTIME_QUALITY_BLEND
  return prior ?? realtime ?? null
}

// What a model's displayed rating rests on, for the provenance badge: a real
// LEADERBOARD (arena/AA, full routing weight) vs the web-research ESTIMATE
// (quarter weight) vs REALTIME real-usage only. null = no scores.
export type ScoreBasis = 'leaderboard' | 'estimate' | 'realtime'
export const scoreBasis = (m: CanonModel, taskType = 'overall'): ScoreBasis | null => {
  let rows = m.taskScores.filter(s => s.task_type === taskType)
  if (!rows.length) rows = m.taskScores // fall back to any task if 'overall' absent
  if (!rows.length) return null
  if (rows.some(s => s.source.startsWith('leaderboard'))) return 'leaderboard'
  if (rows.some(s => s.source === 'research_estimate' || s.source === 'benchmark')) return 'estimate'
  if (rows.some(s => s.source === 'realtime_quality')) return 'realtime'
  return null
}

// Confidence in a task's blended score, mirroring the server router
// (FEEDER_RESEARCH_PRIOR_CONFIDENCE): a real leaderboard is trusted fully, the
// web-research estimate a quarter, realtime-only in between. Used to RANK the
// wiki so a leaderboard-80 model sits above an estimate-93 one (the bar still
// shows the raw score, badged ≈EST).
const RESEARCH_PRIOR_CONFIDENCE = 0.25
const REALTIME_ONLY_CONFIDENCE = 0.6
export const scoreConfidence = (m: CanonModel, taskType = 'overall'): number => {
  let rows = m.taskScores.filter(s => s.task_type === taskType)
  if (!rows.length) rows = m.taskScores
  if (rows.some(s => s.source.startsWith('leaderboard'))) return 1
  if (rows.some(s => s.source === 'research_estimate' || s.source === 'benchmark')) return RESEARCH_PRIOR_CONFIDENCE
  if (rows.some(s => s.source === 'realtime_quality')) return REALTIME_ONLY_CONFIDENCE
  return 1
}
// The wiki ordering key: display rating × how much we trust its source. Null
// (no scores) sorts last. This is what stops an inflated research estimate
// outranking a real leaderboard score.
export const wikiSortScore = (m: CanonModel): number | null => {
  const rs = researchScore(m)
  return rs == null ? null : rs * scoreConfidence(m)
}
// LMArena overall leaderboard position, when this model matched the board.
export const arenaRank = (m: CanonModel): number | null => {
  const r = m.taskScores.find(s => s.task_type === 'overall' && s.source === 'leaderboard_arena')?.rank
  return r ?? null
}

// True when real-usage quality has started reshaping this model's rating — the
// wiki badges it so a reader sees the score is live-evolving, not just arena.
export const hasRealtimeQuality = (m: CanonModel): boolean =>
  m.taskScores.some(s => s.source === 'realtime_quality')

// Largest known param count (billions) across a model's instances, or null.
export const bestParams = (m: CanonModel): number | null => {
  const ps = m.instances.map(i => i.params_b).filter((n): n is number => n != null && n > 0)
  return ps.length ? Math.max(...ps) : null
}
export const prettyParams = (b: number | null): string => b == null ? '' : b >= 1000 ? `${(b / 1000).toFixed(b % 1000 === 0 ? 0 : 1)}T` : `${b}B`

// Research-driven ranking score (0-1). Prefer the true arena 'overall' ELO
// (blended with real-usage quality); otherwise the mean of the per-task
// blended scores. Then tilt by size so a big model outranks a small one at
// equal arena score — the wiki's dynamic, evolving rating. null only when a
// model has NO scores at all. Drives the wiki's ordering.
export const researchScore = (m: CanonModel): number | null => {
  let base = blendedTaskScore(m, 'overall')
  if (base == null) {
    const types = [...new Set(m.taskScores.filter(s => s.task_type !== 'overall').map(s => s.task_type))]
    const cats = types.map(t => blendedTaskScore(m, t)).filter((n): n is number => n != null)
    if (!cats.length) return null
    base = cats.reduce((a, b) => a + b, 0) / cats.length
  }
  // Tilt by size: equal arena, bigger model rates higher (0.5..1.0 → keeps
  // 50-100% of the score). Bounded so a small model with real quality still
  // ranks sensibly, never zeroed.
  return base * (0.5 + 0.5 * canonSizeFactor(m))
}
