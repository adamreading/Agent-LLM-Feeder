import { getPool } from '../db/index.js';
import { all, get } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from './ratelimit.js';
import { getHealthMap, type ModelHealthRow } from './modelHealth.js';
import type { BaseProvider } from '../providers/base.js';

interface ModelRow {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  context_window: number | null;
  cost_tier: string;
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: boolean;
}

interface FallbackRow {
  model_db_id: number;
  enabled: boolean;
  intelligence_rank: number;
  size_label: string;
}

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: string;
  displayName: string;
  /** Resolved context length (estimated request size, capped by the model's
   * declared context_window) — threaded into CompletionOptions.context_length
   * so providers whose backend defaults to a small window (Ollama) are
   * explicitly told to use this much, not just permitted to in the abstract. */
  contextLength: number;
}

// Capability need — an OPAQUE string, deliberately not a closed union.
// 'json_mode' and 'reasoning_control' are the two feeder-NATIVE special
// cases (checked against provider.dialect, a wire-format fact feeder owns
// as a translation layer). Anything else — 'tools' or any caller-invented
// capability name — is checked generically against the model_capabilities
// table (per-model, source='measured' only) with zero feeder-side knowledge
// of what the string MEANS.
//
// This keeps feeder a generic, use-case-agnostic OpenAI-compatible provider
// (like LiteLLM/Ollama): a caller that knows nothing about some consumer's
// private capability (Open WebUI, any generic script) must never be filtered
// by a capability it has no reason to know exists. Callers DECLARE the needs[]
// their own call-site requires (via the request body); feeder only ever
// enforces what's declared, never infers consumer-specific policy from
// task_class itself. (An earlier revision baked a consumer-specific
// task_class→capability mapping into the router — the anti-pattern this
// opaque design exists to prevent.)
export type CapabilityNeed = string;

export interface RouteOptions {
  estimatedTokens?: number;
  /** set of "platform:modelId:keyId" to skip (failed earlier in this request) */
  skipKeys?: Set<string>;
  /** try this model first (sticky session) */
  preferredModelDbId?: number;
  /** L8: never route to these platforms (e.g. the one that just failed) */
  excludeProviders?: Set<string>;
  /** capabilities this request needs; candidates whose provider can't honor them are excluded */
  needs?: CapabilityNeed[];
  /** two-gate INNER enforcement: caps the cost tier this call may reach, independent of caller trust */
  costTierCeiling?: 'free' | 'paid';
  /** L2: caller's declared latency ceiling (ms) — candidates whose historical p95 exceeds it are excluded */
  latencyCeilingMs?: number;
  /** caller-declared task class (from the `auto/<task_class>` sentinel) — maps to
   *  an arena task_type so routing prefers models measured good at THAT task */
  taskClass?: string | null;
  /** internal: set on the self-retry that relaxes the latency ceiling as a last
   *  resort (see the NO_ELIGIBLE_MODEL handler) — prevents infinite recursion */
  _relaxedLatency?: boolean;
}

// L11: typed error contract. NO_ELIGIBLE_MODEL means no candidate matched
// structural needs (capability/cost-tier/context/latency) regardless of
// quota — a caller-visible signal to fall back to its own local/pinned
// option, never a silently substituted wrong model. ALL_RATE_LIMITED means
// eligible candidates existed but every key on every one is currently
// exhausted/on cooldown.
export type RoutingErrorCode = 'NO_ELIGIBLE_MODEL' | 'ALL_RATE_LIMITED';

export class RoutingError extends Error {
  readonly code: RoutingErrorCode;
  readonly status: number;
  constructor(code: RoutingErrorCode, message: string) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
    this.status = code === 'NO_ELIGIBLE_MODEL' ? 422 : 429;
  }
}

// Round-robin index per platform
const roundRobinIndex = new Map<string, number>();

// ── Dynamic priority: track 429s per model and demote accordingly ──
// Key: model_db_id → { count, lastHit, penalty }
const rateLimitPenalties = new Map<number, { count: number; lastHit: number; penalty: number }>();

// Penalty decays over time so models recover
const PENALTY_PER_429 = 3;        // each 429 adds this many priority positions
const MAX_PENALTY = 10;            // cap so a model doesn't sink forever
const DECAY_INTERVAL_MS = 2 * 60 * 1000; // penalty decays every 2 minutes
const DECAY_AMOUNT = 1;            // remove this much penalty per decay interval

/**
 * Record a 429 for a model — increases its penalty so it sinks in priority.
 */
export function recordRateLimitHit(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  const now = Date.now();
  if (existing) {
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(modelDbId, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

/**
 * Record a success for a model — reduces its penalty so it rises back up.
 */
export function recordSuccess(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
    }
  }
}

/**
 * Get the current penalty for a model (with time-based decay).
 */
function getPenalty(modelDbId: number): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;

  // Apply time-based decay
  const now = Date.now();
  const elapsed = now - entry.lastHit;
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - (decaySteps * DECAY_AMOUNT));
    entry.lastHit = now; // reset so we don't double-decay
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
      return 0;
    }
  }

  return entry.penalty;
}

/**
 * Get current penalties for all models (for the API/dashboard).
 */
export function getAllPenalties(): Array<{ modelDbId: number; count: number; penalty: number }> {
  const result: Array<{ modelDbId: number; count: number; penalty: number }> = [];
  for (const [modelDbId, entry] of rateLimitPenalties) {
    const penalty = getPenalty(modelDbId);
    if (penalty > 0) {
      result.push({ modelDbId, count: entry.count, penalty });
    }
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

// ── Step-3 selection scoring ──────────────────────────────────────────────
// Ordering ONLY — never filtering (the hard eligibility filters and the typed-
// error contract are untouched). The flip-window data (wsl, 2026-07-08) showed
// selection within the eligible set had no health/latency signal, so it kept
// landing on 9-12s heavy reasoners while sub-second eligible models sat idle,
// and slow/dead models tried first stacked ~15s failover timeouts. This
// reorders the walk so healthy+fast models are tried first.
//
// Everything is expressed as an additive penalty in the SAME units as the
// existing fallback priority (~1-30, lower=better), so with no health data the
// score reduces exactly to today's (priority + penalty) ordering — fully
// backward compatible (a fresh install / cold cache routes identically).
const HEALTH_WEIGHT = 10;            // a fully-unhealthy model sinks ~10 positions
const LATENCY_TIGHT_DIVISOR = 500;   // chat (tight ceiling): +1 position per 500ms
const LATENCY_TIGHT_CAP = 24;        // a 12s model sinks hard for chat
const LATENCY_LOOSE_DIVISOR = 5000;  // batch (no ceiling): +1 per 5s — latency barely matters
const LATENCY_LOOSE_CAP = 4;         // quality/curated prior dominates for batch
// Dynamic quality: a model's researched arena score for the request's task
// (0-1, higher=better) LIFTS it by up to this many positions. Comparable to
// HEALTH_WEIGHT so genuine task quality competes with the intelligence prior —
// this is what makes "math → high-math model, prose → high-creative model" real.
const TASK_QUALITY_WEIGHT = 12;

// Intelligence/size weighting of the arena lift (Adam, 2026-07-10): a 580B
// model with arena 90 is genuinely better than an 8B with arena 90, so a raw
// arena score must not let a small model leapfrog a big one. We have no exact
// param count — size_label is a coarse capability bucket — so we scale the
// task-quality LIFT by a size factor: a Frontier/Large model gets the full
// lift from its arena score, a Small model only a fraction of it. Model
// intelligence is ALSO already the base ordering prior (intelligence_rank), so
// between the two a bigger/smarter model is favoured on both axes. Unknown/
// unlabelled → a neutral 0.75 (never zero — a strong arena score on an
// unlabelled model shouldn't be discarded, just not over-trusted).
const SIZE_QUALITY_FACTOR: Record<string, number> = {
  frontier: 1.0,
  large: 0.85,
  medium: 0.7,
  small: 0.5,
};
function sizeFactor(sizeLabel: string | null | undefined): number {
  if (!sizeLabel) return 0.75;
  return SIZE_QUALITY_FACTOR[sizeLabel.trim().toLowerCase()] ?? 0.75;
}

// Data-collection fairness (Adam, 2026-07-10): since every real call now
// collects live data (latency/health/quota/observed capabilities), routing
// should give under-observed models a fair turn so we accrue data across the
// WHOLE catalog, not just today's winners. A model we have NO response data
// for gets the STRONGEST pull; once every model has data, the one whose data
// is OLDEST gets the pull — a monotonic staleness bonus (never-seen = maximal
// staleness). Bounded so it nudges ordering without letting a weak stale model
// hijack a quality-sensitive turn, and scaled DOWN under a tight latency
// ceiling (interactive chat — protect Lunk's quality) vs UP with a loose/absent
// one (batch — cheap to explore). Complements the ε-greedy random-K spread,
// which Adam asked to keep; this is the principled, information-gain half.
const COVERAGE_WEIGHT_TIGHT = 3;      // interactive: gentle nudge only
const COVERAGE_WEIGHT_LOOSE = 8;      // batch: explore harder for coverage
const COVERAGE_FULL_AGE_MS = 24 * 60 * 60 * 1000; // untouched ≥24h → full staleness bonus

// A model counts as "long context" only if its declared window clears this bar.
// Adam's call (2026-07-09): don't label an 8k/32k model long-context off a
// low-target needle probe — require a genuinely large window.
export const LONG_CONTEXT_THRESHOLD = 128_000;

// Exploration: with this probability, a random model from the top-K enabled
// candidates is tried FIRST, so every in-range model periodically gets a turn
// and we accrue true latency/health data instead of hammering one winner.
// Read at call time (not module load) so it's overridable; forced OFF under
// vitest so routing tests stay deterministic.
const EXPLORE_TOPK = 6;
function exploreEpsilon(): number {
  if (process.env.VITEST) return 0;
  return Number(process.env.ROUTE_EXPLORE_EPSILON ?? 0.15);
}

// Map a caller's task_class (free-form, from `auto/<task_class>`) to an lmarena
// task_type we hold benchmark scores for. Unknown/absent → 'overall' (the
// general quality prior), so routing is always arena-aware, never worse than
// today. Kept deliberately small + generic (no consumer-specific policy).
const TASK_CLASS_TO_TASK_TYPE: Record<string, string> = {
  coding: 'coding', code: 'coding', programming: 'coding',
  math: 'math', maths: 'math',
  reasoning: 'reasoning', puzzle: 'reasoning', logic: 'reasoning',
  creative: 'creative_writing', creative_writing: 'creative_writing',
  writing: 'creative_writing', prose: 'creative_writing', poetry: 'creative_writing',
  chat: 'multi_turn', agentic_chat: 'multi_turn', conversation: 'multi_turn', multi_turn: 'multi_turn',
  long: 'long_query', long_query: 'long_query', long_context: 'long_query',
  instruction: 'instruction_following', instruction_following: 'instruction_following',
  // feeder's OWN research writer routes as auto/research — it must follow a
  // strict JSON schema, so it's scored on instruction-following.
  research: 'instruction_following', extraction: 'instruction_following',
  // Hermes's OB-write quality signal (task_class:'ob_write', wsl's locked
  // emitter, 2026-07-10): capturing a well-formed thought is structured
  // instruction-following, so its realtime_quality lands on that dimension
  // rather than diluting the general 'overall' prior.
  ob_write: 'instruction_following',
};
export function taskTypeFor(taskClass: string | null | undefined): string {
  if (!taskClass) return 'overall';
  return TASK_CLASS_TO_TASK_TYPE[taskClass.toLowerCase()] ?? 'overall';
}

// How much a REAL-USAGE quality score (source='realtime_quality', from the
// answer-evaluation capture) pulls the routing quality away from the external
// benchmark prior when both exist for a model+task (Adam's "dynamic evolving
// system", 2026-07-10). Bounded < 0.5 so the arena prior still anchors — a few
// noisy early real-usage samples nudge, they don't swing routing. Grows in
// influence naturally as more samples accumulate into the stored average.
const REALTIME_QUALITY_BLEND = 0.4;

// Blend the per-(model,task) rows across sources into ONE score per model.
// Before this, the routing join had no source filter and silently kept
// whichever row the DB returned last when a model had both a 'benchmark' and a
// 'realtime_quality' row — nondeterministic and it discarded one signal.
// Now: the benchmark/measured/declared rows form the PRIOR (arena leaderboard);
// realtime_quality is real-usage evidence that blends over the prior.
function blendTaskScores(
  rows: Array<{ model_db_id: number; score: number; source: string }>,
): Map<number, number> {
  const byModel = new Map<number, { prior: number | null; realtime: number | null }>();
  for (const r of rows) {
    const entry = byModel.get(r.model_db_id) ?? { prior: null, realtime: null };
    if (r.source === 'realtime_quality') entry.realtime = Number(r.score);
    else entry.prior = Number(r.score); // benchmark / measured / declared
    byModel.set(r.model_db_id, entry);
  }
  const out = new Map<number, number>();
  for (const [modelDbId, { prior, realtime }] of byModel) {
    let blended: number | null = null;
    if (prior != null && realtime != null) blended = prior * (1 - REALTIME_QUALITY_BLEND) + realtime * REALTIME_QUALITY_BLEND;
    else blended = prior ?? realtime; // whichever exists
    if (blended != null) out.set(modelDbId, blended);
  }
  return out;
}

// Composite ordering score (lower = tried earlier). health/success-rate always
// counts; latency's WEIGHT scales with the caller's declared latency_ceiling
// (tight → latency dominates for interactive chat; loose/absent → quality
// prior dominates for latency-tolerant batch) — the caller-declared,
// use-case-agnostic shape wsl + windows converged on.
function candidateScore(
  basePriority: number,
  modelDbId: number,
  health: ModelHealthRow | undefined,
  latencyCeilingMs: number | undefined,
  taskScore: number | undefined,
  sizeQualityFactor: number,
  dataAgeMs: number | null,
): number {
  let score = basePriority + getPenalty(modelDbId);

  // Dynamic quality lift: a researched arena score for THIS task pulls the
  // model up (higher score = lower composite = tried earlier). Scaled by the
  // model's size/capability factor so a big model beats a small one at equal
  // arena score (Adam, 2026-07-10). Applies whether or not health data exists,
  // so quality steers even a cold pool.
  if (taskScore != null) score -= Math.max(0, Math.min(1, taskScore)) * TASK_QUALITY_WEIGHT * sizeQualityFactor;

  // Data-collection fairness: pull under-observed models up so we accrue live
  // data across the whole catalog. Never-seen (dataAgeMs == null) = maximal
  // staleness = full bonus; a model seen ≥COVERAGE_FULL_AGE_MS ago also gets
  // the full bonus; a just-used model gets ~none. Weight scales with the
  // latency ceiling (explore less on tight interactive turns).
  const coverageWeight = latencyCeilingMs != null ? COVERAGE_WEIGHT_TIGHT : COVERAGE_WEIGHT_LOOSE;
  const staleFrac = dataAgeMs == null ? 1 : Math.min(1, dataAgeMs / COVERAGE_FULL_AGE_MS);
  score -= coverageWeight * staleFrac;

  if (!health) return score; // no health data → intelligence prior + task quality + coverage only

  const clampedHealth = Math.max(0, Math.min(1, health.health_score));
  score += (1 - clampedHealth) * HEALTH_WEIGHT;

  if (health.recent_latency_ms != null) {
    const [divisor, cap] = latencyCeilingMs != null
      ? [LATENCY_TIGHT_DIVISOR, LATENCY_TIGHT_CAP]
      : [LATENCY_LOOSE_DIVISOR, LATENCY_LOOSE_CAP];
    score += Math.min(health.recent_latency_ms / divisor, cap);
  }
  return score;
}

async function getP95LatencyMs(pool: ReturnType<typeof getPool>, platform: string, modelId: string): Promise<number | null> {
  const row = await get<{ p95: string | null }>(pool, `
    SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
    FROM requests
    WHERE platform = ? AND model_id = ? AND status = 'success' AND is_probe = false
  `, [platform, modelId]);
  return row?.p95 != null ? Number(row.p95) : null;
}

/**
 * Route a request to the best available model.
 * Models are sorted by (base_priority + rate_limit_penalty) so frequently
 * rate-limited models automatically sink below working ones.
 *
 * If preferredModelDbId is set, that model gets tried FIRST (sticky sessions).
 * This prevents hallucination from model switching mid-conversation.
 *
 * Capability/cost-tier/context/latency checks are evaluated fresh per
 * candidate on every call (never a stale pre-filtered snapshot) — a model's
 * eligibility can only be assessed against current DB + in-memory state.
 */
export async function routeRequest(options: RouteOptions = {}): Promise<RouteResult> {
  const {
    estimatedTokens = 1000,
    skipKeys,
    preferredModelDbId,
    excludeProviders,
    needs,
    costTierCeiling,
    latencyCeilingMs,
    taskClass,
  } = options;

  const pool = getPool();

  // The base ordering prior is the model's CURRENT intelligence_rank — not the
  // fallback_config.priority column, which had drifted to catalog insertion
  // order as models were added over time (a genuinely-smarter new model was
  // being appended BELOW older weaker ones). fc.enabled is still honored as a
  // manual on/off; ordering is the algorithm's job (intelligence + task quality
  // + health + latency + exploration), not a hand-maintained priority list.
  const fallbackChain = await all<FallbackRow>(pool, `
    SELECT fc.model_db_id, fc.enabled, m.intelligence_rank, m.size_label
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    ORDER BY m.intelligence_rank ASC
  `);

  // Preload the arena task score for THIS request's task (one query, keyed by
  // model_db_id via the model's canonical grouping). taskType defaults to
  // 'overall' so plain requests still get the general quality prior.
  const taskType = taskTypeFor(taskClass);
  const taskScoreRows = await all<{ model_db_id: number; score: number; source: string }>(pool, `
    SELECT m.id AS model_db_id, ts.score, ts.source
    FROM models m
    JOIN task_scores ts ON ts.canonical_model_id = m.canonical_model_id AND ts.task_type = ?
  `, [taskType]);
  const taskScoreMap = blendTaskScores(taskScoreRows);

  // Data-collection fairness (Adam, 2026-07-10): preload how long ago we last
  // got a real (non-probe) response from each model — the freshness of ALL its
  // response-derived data (latency/health/quota/observed capabilities). A model
  // absent from this map has never been exercised → strongest exploration pull.
  const dataAgeRows = await all<{ model_db_id: number; age_ms: string }>(pool, `
    SELECT m.id AS model_db_id, EXTRACT(EPOCH FROM (now() - max(r.created_at))) * 1000 AS age_ms
    FROM models m
    JOIN requests r ON r.platform = m.platform AND r.model_id = m.model_id AND r.is_probe = false
    GROUP BY m.id
  `);
  const dataAgeMap = new Map(dataAgeRows.map(r => [r.model_db_id, Number(r.age_ms)]));

  // Step-3 selection: order by the composite score (see candidateScore).
  // healthMap is the persisted cron-derived summary — one cheap read per call.
  const healthMap = await getHealthMap(pool);
  const sortedChain = fallbackChain.map(entry => ({
    ...entry,
    effectivePriority: candidateScore(
      entry.intelligence_rank, entry.model_db_id, healthMap.get(entry.model_db_id), latencyCeilingMs,
      taskScoreMap.get(entry.model_db_id), sizeFactor(entry.size_label),
      dataAgeMap.has(entry.model_db_id) ? dataAgeMap.get(entry.model_db_id)! : null,
    ),
  })).sort((a, b) => a.effectivePriority - b.effectivePriority);

  // Sticky session: move preferred model to front of chain
  if (preferredModelDbId) {
    const idx = sortedChain.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx > 0) {
      const [preferred] = sortedChain.splice(idx, 1);
      sortedChain.unshift(preferred);
    }
  } else if (exploreEpsilon() > 0 && Math.random() < exploreEpsilon()) {
    // ε-greedy exploration (only when NOT pinned to a sticky model): give a
    // random one of the top-K enabled candidates the first shot. It still
    // passes every capability/latency/quota filter in the walk below, so this
    // never serves an ineligible model — it just spreads real traffic across
    // in-range models so we accrue true latency/health instead of hammering
    // one winner. 85% of the time the best-scored model still leads.
    const top = sortedChain.filter(e => e.enabled).slice(0, EXPLORE_TOPK);
    if (top.length > 1) {
      const pick = top[Math.floor(Math.random() * top.length)];
      const idx = sortedChain.indexOf(pick);
      if (idx > 0) { sortedChain.splice(idx, 1); sortedChain.unshift(pick); }
    }
  }

  // L11: tracks whether ANY candidate ever cleared the structural checks
  // (capability/cost-tier/context/latency), independent of key/quota
  // availability — distinguishes "nothing can ever satisfy this" from
  // "eligible candidates exist but are all rate-limited right now."
  let anyStructurallyEligible = false;

  for (const entry of sortedChain) {
    if (!entry.enabled) continue;

    // Get model details — fresh per candidate, per call (L9).
    const model = await get<ModelRow>(pool, 'SELECT * FROM models WHERE id = ? AND enabled = true', [entry.model_db_id]);
    if (!model) continue;

    // L8: caller-excluded platform (e.g. the one that just failed upstream).
    if (excludeProviders?.has(model.platform)) continue;

    // Check if we have a provider for this platform
    const provider = getProvider(model.platform as any);
    if (!provider) continue;

    // Capability/dialect gate: never send a field a provider can't honor.
    // json_mode/reasoning_control are the two feeder-NATIVE concepts — they
    // gate on HOW this layer talks to a provider's wire format
    // (DialectConfig), which is inherently feeder's own job as a translation
    // layer, same as any generic multi-provider proxy (LiteLLM, Ollama).
    if (needs?.includes('json_mode') && !provider.dialect.jsonMode) continue;
    if (needs?.includes('reasoning_control') && !provider.dialect.reasoning) continue;

    // long_context is DERIVED from the declared context window, not a probe —
    // a needle probe was awarding it at absurdly low targets (~5k), tagging an
    // 8k model "long context". A model IS long-context iff its window clears a
    // real bar. Per-candidate, so the 8k SambaNova instance of a model is
    // excluded while the 131k NVIDIA/Groq instances qualify.
    if (needs?.includes('long_context') && (model.context_window == null || model.context_window < LONG_CONTEXT_THRESHOLD)) continue;

    // Everything else in needs[] is an OPAQUE per-model capability string —
    // feeder doesn't know or care what it MEANS (tools, or anything a caller
    // declares), only whether some caller has reported it measured-true for
    // this specific model. This is what keeps feeder a generic, use-case-
    // agnostic provider: consumer-specific policy (e.g. "this task needs my
    // private capability X") lives in the CALLER, not hardcoded here — a
    // generic client (Open WebUI, any script) that declares no needs[] gets
    // pure priority + tools-from-request-body; a policy-aware caller declares
    // exactly what its call-site requires.
    //
    // source IN ('measured','observed') — deliberately NOT 'declared'. This is
    // a hard safety gate, not a heuristic. Probe work exists because
    // declared/spec-sheet claims (NVIDIA reasoning, Groq reasoning, Ollama
    // context) turned out wrong often enough to matter live; an unverified
    // claim must never satisfy a capability a caller is relying on for
    // correctness. 'observed' is admitted because it is VERIFIED-BY-REAL-USE
    // (the model actually returned tool_calls on production traffic — see
    // capabilityObserve.ts) — proof at least as strong as a synthetic probe,
    // and the token-free way we collect this now that active probe sweeps are
    // banned (Adam, 2026-07-10). The safety property is preserved: only real
    // evidence counts, never a spec-sheet claim.
    const opaqueNeeds = (needs ?? []).filter((n) => n !== 'json_mode' && n !== 'reasoning_control' && n !== 'long_context');
    let missingOpaqueNeed = false;
    for (const need of opaqueNeeds) {
      const row = await get<{ supported: boolean }>(pool,
        `SELECT supported FROM model_capabilities WHERE model_db_id = ? AND capability = ? AND supported = true AND source IN ('measured','observed') LIMIT 1`,
        [model.id, need]
      );
      if (!row) { missingOpaqueNeed = true; break; }
    }
    if (missingOpaqueNeed) continue;

    // Two-gate INNER enforcement: cost-tier ceiling (independent of the
    // outer per-key trust gate applied by the caller before routeRequest
    // is even invoked).
    if (costTierCeiling === 'free' && model.cost_tier !== 'free') continue;

    // Context-length awareness: don't route a request the model's window
    // can't hold, derived from the same token estimate used for rate limits.
    if (model.context_window != null && estimatedTokens > model.context_window) continue;

    // Structural TPM incapacity: a request whose OWN size exceeds the
    // model's entire per-minute token budget can never succeed no matter how
    // long the caller waits — this is a fact about the request shape vs the
    // model's serving tier, not transient exhaustion. Distinct from the
    // canUseTokens() check below (which handles "already used some of this
    // minute's budget" and correctly IS retry-able). Caught live 2026-07-07:
    // groq/gpt-oss-120b declares a 131072 context_window but its free-tier
    // TPM is only 8000 — a 100k-token request 413s regardless of window size.
    // Without this check such a model still set anyStructurallyEligible=true
    // (passed context_window, has a key) and only failed canUseTokens per-key,
    // so the caller got ALL_RATE_LIMITED (429, "retry later") for a request
    // that can NEVER succeed here — the wrong signal for a caller (Hermes)
    // whose fallback-to-Codex net triggers on NO_ELIGIBLE_MODEL (422).
    if (model.tpm_limit != null && estimatedTokens > model.tpm_limit) continue;

    // Latency ceiling: exclude candidates whose historical p95 exceeds the
    // caller's declared budget. No history yet ("null") does not exclude —
    // an unmeasured model isn't known to be slow.
    if (latencyCeilingMs != null) {
      const p95 = await getP95LatencyMs(pool, model.platform, model.model_id);
      if (p95 != null && p95 > latencyCeilingMs) continue;
    }

    // Get all healthy, enabled keys for this platform
    const keys = await all<KeyRow>(pool,
      'SELECT * FROM api_keys WHERE platform = ? AND enabled = true AND status != ?',
      [model.platform, 'invalid']
    );

    if (keys.length === 0) continue;

    // "Structurally eligible" = matches every capability/tier/context/latency
    // requirement AND has at least one configured key — i.e. there is some
    // real path to serving this request right now, even if that path is
    // currently rate-limited. A capability match with zero keys configured
    // isn't a usable option, so it must not suppress NO_ELIGIBLE_MODEL.
    anyStructurallyEligible = true;

    // Circuit-breaker (step 3): skip a model whose health row carries a live
    // cooldown (set by modelHealth when it recently 429'd/timed out). This is
    // a cross-restart / cross-request backstop to the immediate per-key
    // in-memory cooldown below — after a restart the in-memory cooldowns are
    // gone (L7) but the persisted one still steers failover away from a
    // known-dead provider, killing the ~15s-timeout-stacking. Set AFTER
    // anyStructurallyEligible so an all-cooled pool surfaces as ALL_RATE_LIMITED
    // (transient, retryable), never NO_ELIGIBLE_MODEL.
    const health = healthMap.get(model.id);
    if (health?.cooldown_until && new Date(health.cooldown_until).getTime() > Date.now()) continue;

    // Get limits once for this model
    const limits = {
      rpm: model.rpm_limit,
      rpd: model.rpd_limit,
      tpm: model.tpm_limit,
      tpd: model.tpd_limit,
    };

    // Try all keys for this model before giving up on it
    const rrKey = `${model.platform}:${model.model_id}`;
    let idx = roundRobinIndex.get(rrKey) ?? 0;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const key = keys[idx % keys.length];
      idx++;

      const skipId = `${model.platform}:${model.model_id}:${key.id}`;
      if (skipKeys?.has(skipId)) continue;

      // Check cooldown (from previous 429s)
      if (isOnCooldown(model.platform, model.model_id, key.id)) continue;

      if (!canMakeRequest(model.platform, model.model_id, key.id, limits)) continue;
      if (!canUseTokens(model.platform, model.model_id, key.id, estimatedTokens, limits)) continue;

      // We found a working key for this model!
      roundRobinIndex.set(rrKey, idx);
      const decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);

      return {
        provider,
        modelId: model.model_id,
        modelDbId: model.id,
        apiKey: decryptedKey,
        keyId: key.id,
        platform: model.platform,
        displayName: model.display_name,
        contextLength: model.context_window != null ? Math.min(estimatedTokens, model.context_window) : estimatedTokens,
      };
    }

    // If we reach here, this specific model has NO available keys.
    // Update round-robin index even if we failed so we don't get stuck.
    roundRobinIndex.set(rrKey, idx);

    // We don't explicitly penalize the model here because the fact that we
    // couldn't find a key means we will naturally move to the next model
    // in the `sortedChain` for THIS specific request.
  }

  if (!anyStructurallyEligible) {
    // Relax-on-empty (L8/L11 failure mode, seen live 2026-07-10): a large-context
    // request can filter to ZERO eligible models purely because every model that
    // FITS the context is slower than the latency ceiling. A slow real answer
    // from a capable model beats a 422 that drops the caller to a weaker local
    // fallback — so if a ceiling was set and NOTHING qualified under it, retry
    // once ignoring the ceiling. This only ever fires when the ceiling would
    // otherwise yield nothing, so it never picks slow-when-fast-exists (short-
    // context/voice always has fast models that fit → never relaxes).
    if (latencyCeilingMs != null && !options._relaxedLatency) {
      console.log('[Router] NO_ELIGIBLE within latency ceiling — relaxing ceiling as last resort (slow answer beats 422→weak fallback)');
      return routeRequest({ ...options, latencyCeilingMs: undefined, _relaxedLatency: true });
    }
    throw new RoutingError(
      'NO_ELIGIBLE_MODEL',
      'No usable model exists for this request: either nothing in the catalog satisfies the declared requirements ' +
      '(capability, cost tier, context length, or latency ceiling), or no API key is configured for any model that does.',
    );
  }
  throw new RoutingError(
    'ALL_RATE_LIMITED',
    'All eligible models exhausted. Add more API keys or wait for rate limits to reset.',
  );
}

// ── Read-only routing "reality" view (fallback page) ────────────────────────
// Returns the REAL current effective ordering with the score breakdown, using
// the SAME candidateScore + structural checks routeRequest uses — so the UI can
// DISPLAY exactly how models would be prioritised right now, without the page
// controlling anything. Pass a taskClass to see task-specific ordering.
export interface RoutingExplainRow {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  taskScore: number | null;      // 0-1 blended (benchmark prior + realtime_quality) score for the (task) type shown
  penalty: number;               // live in-memory 429 penalty
  healthScore: number | null;    // 0-1
  latencyMs: number | null;      // recent median
  sizeLabel: string;             // capability bucket driving the arena-lift weighting
  dataAgeMs: number | null;      // ms since last real response (null = never exercised → strongest coverage pull)
  disabledReason: string | null; // why a disabled row is off ('no_key'|'unhealthy'|'unreachable'|'paid_tier'|'unavailable'|'manual')
  effectiveScore: number;        // composite (lower = tried earlier)
  keyCount: number;
  cooling: boolean;              // live circuit-breaker cooldown
  costTier: string;
  status: 'eligible' | 'disabled' | 'no_key' | 'cooling';
}

export async function explainRouting(taskClass?: string | null): Promise<{ taskType: string; rows: RoutingExplainRow[] }> {
  const pool = getPool();
  const taskType = taskTypeFor(taskClass);

  const models = await all<{
    id: number; platform: string; model_id: string; display_name: string;
    intelligence_rank: number; size_label: string; cost_tier: string; model_enabled: boolean;
    fc_enabled: boolean; disabled_reason: string | null; key_count: string;
  }>(pool, `
    SELECT m.id, m.platform, m.model_id, m.display_name, m.intelligence_rank, m.size_label,
           m.cost_tier, m.enabled AS model_enabled, m.disabled_reason,
           fc.enabled AS fc_enabled,
           (SELECT count(*) FROM api_keys k WHERE k.platform = m.platform AND k.enabled = true AND k.status != 'invalid') AS key_count
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
  `);

  const healthMap = await getHealthMap(pool);
  const taskRows = await all<{ model_db_id: number; score: number; source: string }>(pool, `
    SELECT m.id AS model_db_id, ts.score, ts.source
    FROM models m
    JOIN task_scores ts ON ts.canonical_model_id = m.canonical_model_id AND ts.task_type = ?
  `, [taskType]);
  const taskScoreMap = blendTaskScores(taskRows);

  const dataAgeRows = await all<{ model_db_id: number; age_ms: string }>(pool, `
    SELECT m.id AS model_db_id, EXTRACT(EPOCH FROM (now() - max(r.created_at))) * 1000 AS age_ms
    FROM models m
    JOIN requests r ON r.platform = m.platform AND r.model_id = m.model_id AND r.is_probe = false
    GROUP BY m.id
  `);
  const dataAgeMap = new Map(dataAgeRows.map(r => [r.model_db_id, Number(r.age_ms)]));

  const now = Date.now();
  const rows: RoutingExplainRow[] = models.map(m => {
    const health = healthMap.get(m.id);
    const taskScore = taskScoreMap.has(m.id) ? taskScoreMap.get(m.id)! : null;
    const dataAgeMs = dataAgeMap.has(m.id) ? dataAgeMap.get(m.id)! : null;
    const keyCount = Number(m.key_count);
    const cooling = !!(health?.cooldown_until && new Date(health.cooldown_until).getTime() > now);
    const effectiveScore = candidateScore(m.intelligence_rank, m.id, health, undefined, taskScore ?? undefined, sizeFactor(m.size_label), dataAgeMs);
    const status: RoutingExplainRow['status'] =
      (!m.model_enabled || !m.fc_enabled) ? 'disabled'
        : keyCount === 0 ? 'no_key'
          : cooling ? 'cooling'
            : 'eligible';
    return {
      modelDbId: m.id, platform: m.platform, modelId: m.model_id, displayName: m.display_name,
      intelligenceRank: m.intelligence_rank, taskScore, penalty: getPenalty(m.id),
      healthScore: health ? Math.max(0, Math.min(1, health.health_score)) : null,
      latencyMs: health?.recent_latency_ms ?? null,
      sizeLabel: m.size_label, dataAgeMs, disabledReason: m.disabled_reason,
      effectiveScore, keyCount, cooling, costTier: m.cost_tier, status,
    };
  });

  // Disabled/no-key models sort to the bottom regardless of score (they can't
  // actually be picked), then by effective score — the true reality order.
  const rank = (r: RoutingExplainRow) => (r.status === 'disabled' || r.status === 'no_key') ? 1 : 0;
  rows.sort((a, b) => rank(a) - rank(b) || a.effectiveScore - b.effectiveScore);
  return { taskType, rows };
}
