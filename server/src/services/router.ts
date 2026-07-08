import { getPool } from '../db/index.js';
import { all, get } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown } from './ratelimit.js';
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
  priority: number;
  enabled: boolean;
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
// as a translation layer). Anything else — 'tools', 'ob_readwrite', or a
// future caller-invented name — is checked generically against the
// model_capabilities table (per-model, source='measured' only) with zero
// feeder-side knowledge of what the string MEANS.
//
// Corrected 2026-07-08 (Adam's architecture directive, after wsl-claude's
// server-side agentic_chat→ob_readwrite sentinel mapping was found to bake
// Hermes/Open-Brain-specific POLICY into feeder's generic router): a caller
// that knows nothing about Open Brain (Open WebUI, any generic script)
// must never be filtered by a capability it has no reason to know exists.
// Feeder stays a generic, use-case-agnostic OpenAI-compatible provider
// (like LiteLLM/Ollama) — callers DECLARE the needs[] their own call-site
// requires (via the request body); feeder only ever enforces what's
// declared, never infers consumer-specific policy from task_class itself.
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
  } = options;

  const pool = getPool();

  // Get fallback chain ordered by priority
  const fallbackChain = await all<FallbackRow>(pool, `
    SELECT fc.model_db_id, fc.priority, fc.enabled
    FROM fallback_config fc
    ORDER BY fc.priority ASC
  `);

  // Apply dynamic penalties: sort by (base priority + penalty)
  const sortedChain = fallbackChain.map(entry => ({
    ...entry,
    effectivePriority: entry.priority + getPenalty(entry.model_db_id),
  })).sort((a, b) => a.effectivePriority - b.effectivePriority);

  // Sticky session: move preferred model to front of chain
  if (preferredModelDbId) {
    const idx = sortedChain.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx > 0) {
      const [preferred] = sortedChain.splice(idx, 1);
      sortedChain.unshift(preferred);
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

    // Everything else in needs[] is an OPAQUE per-model capability string —
    // feeder doesn't know or care what it MEANS (tools, ob_readwrite, or
    // anything a future caller declares), only whether some caller has
    // reported it measured-true for this specific model. This is what keeps
    // feeder a generic, use-case-agnostic provider (Adam's architecture
    // directive, 2026-07-08): consumer-specific policy (e.g. "agentic_chat
    // needs ob_readwrite") lives in the CALLER, not hardcoded here — a
    // generic client (Open WebUI, any script) that declares no needs[] gets
    // pure priority + tools-from-request-body; a policy-aware caller
    // (Hermes) declares exactly what its call-site requires.
    //
    // source = 'measured' ONLY, deliberately not falling back to 'declared'
    // — this is a hard safety gate, not a heuristic. The whole night's probe
    // work exists because declared/spec-sheet claims (NVIDIA reasoning, Groq
    // reasoning, Ollama context) turned out wrong often enough to matter
    // live; an unverified claim must never satisfy a capability a caller is
    // relying on for correctness (ob-claude's tools-gate review, 2026-07-07,
    // generalizes to every opaque capability a caller might declare).
    const opaqueNeeds = (needs ?? []).filter((n) => n !== 'json_mode' && n !== 'reasoning_control');
    let missingOpaqueNeed = false;
    for (const need of opaqueNeeds) {
      const row = await get<{ supported: boolean }>(pool,
        `SELECT supported FROM model_capabilities WHERE model_db_id = ? AND capability = ? AND supported = true AND source = 'measured' LIMIT 1`,
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
