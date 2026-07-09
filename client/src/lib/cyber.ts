// Shared helpers + constants for the AGENT//FEEDER cyberpunk pages.

// One colour per supplier — consistent everywhere a platform appears.
export const platformColors: Record<string, string> = {
  google: '#4285f4', groq: '#f55036', cerebras: '#8b5cf6', sambanova: '#14b8a6',
  nvidia: '#76b900', mistral: '#f59e0b', openrouter: '#ec4899', github: '#6e7b8b',
  cohere: '#d946ef', cloudflare: '#f38020', zhipu: '#06b6d4', ollama: '#c9c9d6',
  kilo: '#7c3aed', pollinations: '#a855f7', llm7: '#0ea5e9',
}
export const platformColor = (p: string) => platformColors[p] ?? '#94a3b8'

// Display names + the canonical platform list (matches the server's PLATFORMS
// enum in routes/keys.ts) for the Key Vault add-key select and group headers.
export const PLATFORM_NAMES: Record<string, string> = {
  google: 'Google AI Studio', groq: 'Groq', cerebras: 'Cerebras', sambanova: 'SambaNova',
  nvidia: 'NVIDIA NIM', mistral: 'Mistral', openrouter: 'OpenRouter', github: 'GitHub Models',
  cohere: 'Cohere', cloudflare: 'Cloudflare Workers AI', zhipu: 'Z.ai / Zhipu', ollama: 'Ollama Cloud',
  kilo: 'Kilo Gateway', pollinations: 'Pollinations', llm7: 'LLM7',
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
export const overallScore = (m: CanonModel) =>
  m.taskScores.find(s => s.task_type === 'overall')?.score ?? null

// Research-driven ranking score (0-1). Prefer the true arena 'overall' ELO;
// otherwise fall back to the mean of whatever per-task benchmark scores the
// research produced. null only when a model has NO research scores at all.
// Drives the wiki's dynamic ordering so better-researched models rise.
export const researchScore = (m: CanonModel): number | null => {
  const overall = m.taskScores.find(s => s.task_type === 'overall')?.score
  if (overall != null) return overall
  const cats = m.taskScores.filter(s => s.task_type !== 'overall').map(s => s.score)
  if (!cats.length) return null
  return cats.reduce((a, b) => a + b, 0) / cats.length
}
