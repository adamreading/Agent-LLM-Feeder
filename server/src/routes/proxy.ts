import crypto from 'crypto';
import { performance } from 'node:perf_hooks';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage, Platform } from '@freellmapi/shared/types.js';
import { getProvider } from '../providers/index.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { routeRequest, recordRateLimitHit, recordSuccess, RoutingError, type RouteResult, type CapabilityNeed } from '../services/router.js';
import { classifyPrompt, latestUserText, hasImageContent } from '../services/promptClassifier.js';
import { rescueInlineToolCalls, containsDialectMarker } from '../lib/tool-call-rescue.js';
import { getContextHandoffMode, recordIncomingMessages, recordSuccessfulModel, maybeInjectContextHandoff, hasPriorModel, HANDOFF_MAX_TOKENS } from '../services/context-handoff.js';
import { parseAugmentPolicy, augmentDefault, shouldAugment, runWebAugment, isAugmentBlockedConsumer } from '../services/augment.js';
import { recordRequest, recordTokens, setCooldown, isOnCooldown } from '../services/ratelimit.js';
import { harvestQuotaHeaders } from '../services/quotaHarvest.js';
import { observeCapabilities, recordVisionUnsupported } from '../services/capabilityObserve.js';
import { markCapabilitySuspect } from '../services/probes/runner.js';
import { benchUnreachableModel, setQuotaExhausted } from '../services/modelHealth.js';
import { isSwarmConsumer, hasLane, heldPlatformsExcluding, recordLane, withAssignLock } from '../services/swarmLanes.js';
import { checkBudget, recordSpend } from '../services/swarmBudget.js';
import { checkProgress, recordProgress } from '../services/swarmProgress.js';
import { getPool, getUnifiedApiKey } from '../db/index.js';
import { all, get, run } from '../db/pgCompat.js';

export const proxyRouter = Router();

// Constant-time string comparison — used for both the legacy unified-key
// fallback and (implicitly, via hash-then-compare) consumer key lookups, so
// a network attacker can't use response timing to recover a valid token.
function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const compareA = a.length === b.length ? a : Buffer.alloc(b.length);
  return crypto.timingSafeEqual(compareA, b) && a.length === b.length;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// L4 two-gate OUTER enforcement: which trust tier does this caller's Bearer
// token carry? 'fleet' = full catalog eligible; 'external' = hard-clamped to
// free tier regardless of anything else the request declares. Local
// (127.0.0.1) requests are the operator's own machine — treated as fleet.
type TrustTier = 'fleet' | 'external';

// Caller-declared agent label for request attribution — telemetry only, never a
// trust signal (the key/tier decides trust). Strip anything but word chars and a
// few safe separators, cap length, so a self-declared label can't inject junk
// into the request log.
function sanitizeConsumerLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/[^\w.\-:/]/g, '').slice(0, 64);
  return s.length > 0 ? s : null;
}

// A session identifier supplied via the `X-Session-Id` header. OpenCode
// (1.17.20+) natively stamps this on every provider request — stable across
// one `opencode run` invocation, distinct across invocations — with no client
// plumbing. Feeder reads it as a LAST-resort session key (body session_id/user
// still win) so an OpenCode/OpenAI-compat caller gets sticky-session pinning
// and per-session request attribution for free. Sanitised + capped (session
// ids like `ses_2f3a…` are word/`.-:` chars); longer cap than a consumer label.
function sanitizeSessionId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().replace(/[^\w.\-:]/g, '').slice(0, 128);
  return s.length > 0 ? s : undefined;
}

// A swarm RUN id supplied via `X-Run-Id` (RINGER, 2026-07-15) = agent_tasks.id,
// baked literally per-invocation into the OpenCode config so it survives
// OpenCode's wire (unlike X-Session-Id, which OpenCode overwrites per call).
// Groups every worker/attempt of one swarm run so cumulative spend can be
// metered + hard-capped (services/swarmBudget.ts). Same charset/cap as a
// session id; null for all non-swarm traffic.
function sanitizeRunId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().replace(/[^\w.\-:]/g, '').slice(0, 128);
  return s.length > 0 ? s : undefined;
}

async function resolveTrustTier(req: Request): Promise<{ tier: TrustTier; authorized: boolean; consumer: string }> {
  const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');

  // A tokenless localhost call is trusted as fleet (unchanged) — but label it
  // by whether it presented a token, so 'local' vs a named key is visible in
  // the request log (wsl's attribution request, 2026-07-08).
  if (isLocal && !token) return { tier: 'fleet', authorized: true, consumer: 'local' };

  if (!token) return { tier: 'external', authorized: false, consumer: 'unauthenticated' };

  const row = await get<{ trust_tier: string; label: string }>(getPool(),
    'SELECT trust_tier, label FROM consumer_keys WHERE key_hash = ? AND enabled = true',
    [hashToken(token)]
  );
  if (row) return { tier: row.trust_tier === 'fleet' ? 'fleet' : 'external', authorized: true, consumer: row.label };

  // Legacy fallback: a caller presenting the raw unified_api_key directly
  // (pre-consumer_keys migration path). Migrated installs already have this
  // key's hash IN consumer_keys as a 'fleet' row, so this only matters if
  // that row was somehow removed — kept for defense in depth, not the
  // primary path.
  const unifiedKey = await getUnifiedApiKey();
  if (timingSafeStringEqual(token, unifiedKey)) return { tier: 'fleet', authorized: true, consumer: 'unified-key' };

  // A localhost caller that DID present a token we don't recognize: still
  // fleet-trusted by locality (unchanged behavior), but labeled as such.
  if (isLocal) return { tier: 'fleet', authorized: true, consumer: 'local-unknown-token' };

  return { tier: 'external', authorized: false, consumer: 'unknown-key' };
}

// Sticky sessions: track which model served each "session". Prefer an
// explicit session_id/user field (stable across a caller's own conversation
// tracking); fall back to a hash of the first user message when neither is
// present (today's behavior, unchanged for callers that don't send one).
const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 min session TTL

function getSessionKey(messages: ChatMessage[], explicitSessionId?: string): string {
  if (explicitSessionId) return `session:${explicitSessionId}`;
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser || typeof firstUser.content !== 'string') return '';
  const hash = crypto.createHash('sha1').update(firstUser.content).digest('hex');
  return `hash:${hash}:${messages.length > 2 ? 'multi' : 'single'}`;
}

function getStickyModel(messages: ChatMessage[], explicitSessionId?: string): number | undefined {
  // Only apply sticky for multi-turn (has assistant messages = continuation),
  // UNLESS an explicit session_id was given — an explicit id is the caller
  // asserting "this is one session" even for its first turn.
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant && !explicitSessionId) return undefined;

  const key = getSessionKey(messages, explicitSessionId);
  if (!key) return undefined;

  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

function setStickyModel(messages: ChatMessage[], modelDbId: number, explicitSessionId?: string) {
  const key = getSessionKey(messages, explicitSessionId);
  if (!key) return;
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  // Cleanup old entries
  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
  }
}

// OpenAI-compatible /models endpoint (used by Hermes for metadata)
// Sampling/generation params forwarded to every OpenAI-compat provider. Kept in
// sync with buildBody's standard passthrough set (openai-compat.ts). Advertised
// per-model in /v1/models via supportedParamsFor.
const BASE_SUPPORTED_PARAMS = [
  'temperature', 'top_p', 'max_tokens', 'max_completion_tokens',
  'frequency_penalty', 'presence_penalty', 'seed', 'stop', 'n',
  'logit_bias', 'logprobs', 'top_logprobs',
  'tools', 'tool_choice', 'parallel_tool_calls',
] as const;
const EXTENDED_SAMPLING_PARAMS = ['top_k', 'min_p', 'repetition_penalty'] as const;

/** The params a given model's provider will actually honor — advisory metadata
 * for callers; the wire truth is each adapter's body builder. Only the
 * OpenAI-compat path forwards the full standard passthrough (buildBody); the
 * custom adapters (Google/Cohere/Cloudflare) forward just the core three, so we
 * advertise conservatively rather than over-claim. Dialect gates add
 * response_format / reasoning_effort / vendor sampling; dropParams removes any
 * the provider is known to reject. */
function supportedParamsFor(platform: string): string[] {
  const provider = getProvider(platform as Platform);
  const d = provider?.dialect ?? {};
  const params = new Set<string>();
  if (provider instanceof OpenAICompatProvider) {
    for (const p of BASE_SUPPORTED_PARAMS) params.add(p);
    if (d.extendedSampling) for (const p of EXTENDED_SAMPLING_PARAMS) params.add(p);
  } else {
    // Custom adapters forward only these on the wire (see google/cohere/cloudflare).
    for (const p of ['temperature', 'top_p', 'max_tokens']) params.add(p);
  }
  if (d.jsonMode) params.add('response_format');
  if (d.reasoning) params.add('reasoning_effort');
  for (const p of d.dropParams ?? []) params.delete(p);
  return Array.from(params);
}

proxyRouter.get('/models', async (_req: Request, res: Response) => {
  const models = await all<any>(getPool(), 'SELECT platform, model_id, display_name, context_window FROM models WHERE enabled = true ORDER BY intelligence_rank');
  res.json({
    object: 'list',
    data: models.map(m => ({
      id: m.model_id,
      object: 'model',
      created: 0,
      owned_by: m.platform,
      name: m.display_name,
      context_window: m.context_window,
      supported_parameters: supportedParamsFor(m.platform),
    })),
  });
});

const DEFAULT_MAX_RETRIES = 20;

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }),
  thought_signature: z.string().optional(),
});

const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.string(),
  name: z.string().optional(),
});

// Multimodal content parts (OpenAI vision wire format). A user turn may carry a
// plain string OR an array mixing text and image_url parts. Only user messages
// accept the array form — system/assistant/tool stay string-only.
const textContentPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
const imageContentPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().min(1),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});
const contentPartSchema = z.union([textContentPartSchema, imageContentPartSchema]);

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(contentPartSchema).min(1)]),
  name: z.string().optional(),
});

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().nullable().optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
}).refine((msg) => {
  const hasContent = typeof msg.content === 'string' && msg.content.length > 0;
  const hasToolCalls = (msg.tool_calls?.length ?? 0) > 0;
  return hasContent || hasToolCalls;
}, {
  message: 'assistant messages must include non-empty content or tool_calls',
});

const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.string(),
  tool_call_id: z.string().min(1),
  name: z.string().optional(),
});

const toolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }),
  }),
]);

const responseFormatSchema = z.object({
  type: z.enum(['json_object', 'json_schema']),
  json_schema: z.object({
    name: z.string(),
    schema: z.record(z.string(), z.unknown()),
    strict: z.boolean().optional(),
  }).optional(),
});

const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  // Sampling passthrough (P2c-iii). Standard OpenAI generation params — forwarded
  // to every provider (openai-compat drops any a specific provider is known to
  // reject via dialect.dropParams). Only emitted downstream when the caller sets
  // them, so the common path is byte-identical to before.
  frequency_penalty: z.number().min(-2).max(2).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  n: z.number().int().positive().optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().min(0).max(20).optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  // Vendor/non-OpenAI sampling params — only reach providers whose dialect
  // declares extendedSampling (OpenRouter, Ollama); silently not forwarded to
  // providers that would 400 on them, so a caller setting these never breaks a
  // route that doesn't understand them.
  top_k: z.number().int().positive().optional(),
  min_p: z.number().min(0).max(1).optional(),
  repetition_penalty: z.number().positive().optional(),
  stream: z.boolean().optional(),
  tools: z.array(toolDefinitionSchema).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  // P2 additions
  response_format: responseFormatSchema.optional(),
  reasoning_effort: z.enum(['none', 'low', 'medium', 'high']).optional(),
  exclude_providers: z.array(z.string()).optional(),
  max_attempts: z.number().int().positive().max(DEFAULT_MAX_RETRIES).optional(),
  latency_ceiling_ms: z.number().int().positive().optional(),
  // Generic, opaque capability declaration — the caller states what its
  // own call-site requires (e.g. an agentic turn declaring
  // ['tools','long_context']); feeder enforces whatever's named here
  // against model_capabilities without needing to know what any of it
  // means. Replaces a hardcoded task_class→capability mapping that would
  // bake consumer-specific policy into the generic router — see router.ts's
  // CapabilityNeed comment.
  needs: z.array(z.string()).optional(),
  session_id: z.string().optional(),
  user: z.string().optional(), // OpenAI-standard field, also accepted as a sticky-session carrier
  // Per-agent attribution label. Fleet agents (Hermes/Lunk/OpenClaw) share ONE
  // fleet key, so every request logs consumer='fleet' and can't be attributed.
  // A caller self-labels here (or via the X-Consumer header) — telemetry only,
  // NOT a trust signal (the key/tier still decides trust). Sanitised + capped.
  consumer: z.string().max(64).optional(),
  // Phase 4 web-search augment policy (or X-Augment header). 'off' (DEFAULT) =
  // never augmented — the provenance carve-out, so grounded callers that don't
  // opt in are never web-contaminated. 'auto' = feeder searches when the prompt
  // needs current info; 'force' = always search. Anything else → 'off'.
  augment: z.enum(['off', 'auto', 'force']).optional(),
  // Opt-in reasoning suppression (2026-07-08) — see CompletionOptions in
  // providers/base.ts. Generic; any caller sets it, feeder never imposes it.
  exclude_reasoning: z.boolean().optional(),
});

// A non-retryable error that means THIS model/key can't serve the request at
// all — as opposed to a request-shaped 400 (bad params, context too long) which
// must NOT bench a healthy model. Used to auto-bench unreachable models.
function isUnreachableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('403') || msg.includes('forbidden')
    || msg.includes('404') || msg.includes('not found')
    || msg.includes('does not exist') || msg.includes('no such model')
    || msg.includes('not authorized') || msg.includes('unauthorized');
}

// Is there ANOTHER key for this platform that could still serve this model —
// one that isn't the key that just failed, isn't already skipped this request,
// and isn't on a live cooldown? Drives the per-key-vs-per-model penalty
// decision: if yes, the model is fine (just this key is limited) so we don't
// sink the model's routing priority. One cheap query, only on the error path.
async function hasOtherUsableKey(platform: string, modelId: string, failingKeyId: number, skipKeys: Set<string>): Promise<boolean> {
  const keys = await all<{ id: number }>(getPool(),
    `SELECT id FROM api_keys WHERE platform = ? AND enabled = true AND status != 'invalid'`, [platform]);
  for (const k of keys) {
    if (k.id === failingKeyId) continue;
    if (skipKeys.has(`${platform}:${modelId}:${k.id}`)) continue;
    if (isOnCooldown(platform, modelId, k.id)) continue;
    return true;
  }
  return false;
}

// A DAILY / tier QUOTA exhaustion — distinct from a transient per-minute rate
// limit. The model is dead until the quota window resets (hours), so it should
// be PARKED long (setQuotaExhausted), not retried every 90s. Deliberately
// CONSERVATIVE: match only clear quota/daily/billing language; a bare
// "429 / rate limit" stays a short transient cooldown. (Gemini's "exceeded your
// current quota" and OpenRouter's "free-models-per-day" are the live cases.)
function isQuotaExhaustionError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('exceeded your current quota')
    || msg.includes('insufficient_quota')
    || msg.includes('quota exceeded')
    || (msg.includes('quota') && msg.includes('exceeded'))
    || msg.includes('per-day') || msg.includes('per day')
    || msg.includes('free-models-per-day')
    || msg.includes('daily limit') || msg.includes('daily quota')
    || msg.includes('billing');
}

function isRetryableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error')
    || isToolCapabilityMismatchError(err);
}

// A GENUINE vision-capability rejection: the provider refused the image content
// itself (hard 400-class error explicitly about image/vision/modality), NOT a
// transient 429/timeout/5xx (busy != incapable). Only this demotes a declared-
// vision model to vision=false under the relaxed vision gate (Adam, 2026-07-13).
// Deliberately conservative: must mention an image/vision term AND read as a
// rejection, and must not be transient — anything ambiguous leaves the model
// eligible (it just fails over) rather than wrongly marking it non-vision.
function isVisionRejectionError(err: any): boolean {
  if (isRetryableError(err)) return false;
  const msg = (err?.message ?? '').toLowerCase();
  if (!msg) return false;
  const mentionsImage = /image|vision|multimodal|modalit|image_url|inline_?data/.test(msg);
  const rejection = /not support|unsupported|does not|doesn'?t|cannot|can'?t|invalid|not a valid|not allowed|text[- ]only|only text|no such|400/.test(msg);
  return mentionsImage && rejection;
}

// L9 runtime feedback: a live provider error explicitly saying tool-calling
// isn't supported (real observed shape, groq/compound: "`tool calling` is
// not supported with this model") means a MEASURED-true capability just
// regressed — the underlying model behind this platform/model_id changed,
// or the original measurement was wrong. Treated as retryable (try the next
// tools-capable candidate rather than hard-failing the whole request) AND
// flagged suspect so the probe scheduler re-verifies it, instead of letting
// stale measured=true data silently keep winning this gate forever.
function isToolCapabilityMismatchError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return /tool.{0,40}not.{0,10}support/.test(msg) || /does\s*not\s*support.{0,20}tool/.test(msg);
}

// 'auto' or 'auto/<task_class>' enters orchestration mode (task_class is
// currently recorded for observability only — P4 wires real per-call-site
// tuples; P2 just needs the sentinel to not collide with a real model id).
function parseModelField(model: string | undefined): { taskClass: string | null; isAuto: boolean } {
  if (!model) return { taskClass: null, isAuto: false };
  if (model === 'auto') return { taskClass: null, isAuto: true };
  if (model.startsWith('auto/')) return { taskClass: model.slice('auto/'.length) || null, isAuto: true };
  return { taskClass: null, isAuto: false };
}

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {

  // L4 outer gate: resolve trust tier before anything else. Non-local
  // requests without a recognized token are rejected exactly as before.
  const { tier: trustTier, authorized, consumer: baseConsumer } = await resolveTrustTier(req);
  // Attribution label: caller self-identifies via X-Consumer header or a
  // `consumer` body field (fleet agents share one key → all 'fleet' otherwise);
  // falls back to the key/locality label. Telemetry only. Header wins over body.
  let consumer = baseConsumer;
  if (!authorized) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return;
  }

  // Validate request
  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    // Observable rejection: a restart-dropped in-flight stream resurfaces as a
    // malformed retry (e.g. empty assistant content) and 400s here — log it so
    // deploy impact + a worker's bad calls show up in /api/requests (session
    // from the header, since the body didn't validate).
    logRejection('400', 'invalid_body', parsed.error.errors.map(e => e.message).join(', '),
      sanitizeSessionId(req.header('x-session-id')), sanitizeConsumerLabel(req.header('x-consumer')) ?? baseConsumer);
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map(e => e.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const {
    model: requestedModel, temperature, max_tokens, top_p, stream, tools, tool_choice, parallel_tool_calls,
    response_format, reasoning_effort, exclude_providers, max_attempts, latency_ceiling_ms, session_id, user,
    needs: declaredNeeds, exclude_reasoning,
    frequency_penalty, presence_penalty, seed, stop, n, logit_bias, logprobs, top_logprobs,
    max_completion_tokens, top_k, min_p, repetition_penalty,
  } = parsed.data;
  // Apply the caller's self-declared attribution label (header wins over body).
  const declaredConsumer = sanitizeConsumerLabel(req.header('x-consumer')) ?? sanitizeConsumerLabel(parsed.data.consumer);
  if (declaredConsumer) consumer = declaredConsumer;
  // Sampling passthrough forwarded to every routing attempt (P2c-iii). Built once
  // so both the streaming and non-streaming call sites stay in sync. Undefined
  // fields are dropped by JSON.stringify / the provider's conditional assign.
  const sampling = {
    temperature, max_tokens, top_p, frequency_penalty, presence_penalty, seed, stop, n,
    logit_bias, logprobs, top_logprobs, max_completion_tokens, top_k, min_p, repetition_penalty,
  };
  const messages: ChatMessage[] = parsed.data.messages.map((m): ChatMessage => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content ?? null,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_calls ? { tool_calls: m.tool_calls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: tc.function,
          thought_signature: tc.thought_signature,
        })) } : {}),
      };
    }

    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.tool_call_id,
        ...(m.name ? { name: m.name } : {}),
      };
    }

    return {
      role: m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    };
  });

  // Phase 4 web-search augment (OPT-IN; default 'off' = the provenance carve-out).
  // Runs only when the caller opted in (augment 'auto'/'force', body or X-Augment
  // header), the consumer is NOT hard-blocked (OB 'open-brain' can never be
  // augmented regardless of the field — P4b), and the prompt warrants it. Injects
  // live search results as a LABELLED system grounding message before routing.
  // Placed before the token estimate so the injected context is counted. Fully
  // degrade-safe: any no-config/timeout/error leaves the request unaugmented.
  // Swarm run id (X-Run-Id) — groups all workers/attempts of one swarm run for
  // per-run spend metering + the hard-cap enforcer, and scopes the You.com
  // per-job search spend cap. Independent of session_id (per-attempt). Null for
  // non-swarm traffic. Read here (before augment) so augment can meter per-job.
  const runId = sanitizeRunId(req.header('x-run-id'));
  let augmented = false;
  let augmentSkipped: string | null = null;
  // Precedence (OB P4b, windows' load-bearing point): the consumer hard-block wins
  // over EVERYTHING and is evaluated FIRST — so flipping FEEDER_AUGMENT_DEFAULT to
  // 'auto' someday can never re-open augmentation for a blocked grounded consumer.
  //   1. consumer blocked  -> always 'off' (no path overrides)
  //   2. else explicit per-request field (X-Augment header or body)
  //   3. else the env-driven global default (FEEDER_AUGMENT_DEFAULT, default 'off')
  const rawAugment = req.header('x-augment') ?? parsed.data.augment;
  const augmentPolicy = isAugmentBlockedConsumer(consumer)
    ? 'off'
    : (rawAugment != null ? parseAugmentPolicy(rawAugment) : augmentDefault());
  if (augmentPolicy !== 'off' && shouldAugment(augmentPolicy, latestUserText(messages))) {
    const aug = await runWebAugment(latestUserText(messages), { runId });
    if (aug.context) {
      messages.unshift({ role: 'system', content: aug.context });
      augmented = true;
      console.log(`[Augment] injected web-search context (policy=${augmentPolicy}, consumer=${consumer})`);
    } else {
      // A search was attempted but injected nothing — surface WHY (throttled /
      // no-results / no-config / error) so a caller can back off on 'throttled'
      // rather than fly blind. Degrade-safe: the request still proceeds.
      augmentSkipped = aug.skipped;
      console.log(`[Augment] skipped=${aug.skipped} (policy=${augmentPolicy}, consumer=${consumer})`);
    }
  }

  // Token estimation is intentionally a heuristic (~4 chars per token). Used
  // for routing decisions (skip a model whose budget is too small) and for
  // streaming bookkeeping where the provider doesn't echo a final usage count.
  // Non-streaming requests reconcile against the provider's real `usage` block
  // (see line ~340). Streaming will drift from real consumption — accepted
  // tradeoff because per-request usage isn't always returned mid-stream.
  const estimatedInputTokens = messages.reduce((sum, m) => {
    if (typeof m.content === 'string') return sum + Math.ceil(m.content.length / 4);
    if (!Array.isArray(m.content)) return sum;
    // Multimodal content: count text parts + a rough per-image allowance so the
    // context-window / TPM gates aren't wildly under for vision turns (a tiled
    // image is ~hundreds-1k+ tokens; 800 is a deliberately conservative stand-in).
    for (const p of m.content as Array<{ type?: string; text?: string }>) {
      if (p?.type === 'text' && typeof p.text === 'string') sum += Math.ceil(p.text.length / 4);
      else if (p?.type === 'image_url') sum += 800;
    }
    return sum;
  }, 0);
  const estimatedTotal = estimatedInputTokens + (max_tokens ?? 1000);

  const explicitSessionId = session_id ?? user ?? sanitizeSessionId(req.header('x-session-id'));
  const { taskClass, isAuto } = parseModelField(requestedModel);

  // Tier-0 heuristics: derive capability needs directly from the request's
  // own declared fields — universal, any OpenAI-compatible client, no
  // knowledge of task_class or any particular consumer required.
  const needs: CapabilityNeed[] = [];
  if (response_format) needs.push('json_mode');
  if (tools && tools.length > 0) needs.push('tools');
  // reasoning_effort is IGNORE-AND-ROUTE, not a hard filter (Adam, 2026-07-10,
  // after a stray top-level reasoning_effort='medium' from Hermes v0.18.2 emptied
  // the eligible pool → 422 → 15h Discord blackout). Unlike json_mode/tools/vision
  // (ignoring them = broken/corrupt output), ignoring a reasoning HINT only means
  // the model reasons at its default level — degraded-at-worst, never wrong — so it
  // must never make the pool empty. The param still flows to the provider in
  // CompletionOptions: a provider WITH a reasoning dialect honors it, one WITHOUT
  // silently drops it (applyReasoningDialect in openai-compat.ts adds nothing when
  // this.dialect.reasoning is unset — no 400). A call-site that GENUINELY requires
  // reasoning control (e.g. voice think-off) still gets a HARD gate by declaring
  // 'reasoning_control' explicitly in needs[] below — that path is unchanged.

  // Caller-DECLARED needs (generic `needs[]` body field) — this is how a
  // policy-aware consumer (e.g. an agent's agentic call-site) states what ITS
  // OWN task requires, without feeder having to know what task_class means
  // or hardcode any consumer-specific capability. A hardcoded
  // `taskClass === 'agentic_chat' → needs.push(<private capability>)` mapping
  // would wrongly filter a generic Open WebUI caller hitting the same
  // auto/agentic_chat sentinel by a capability it has no reason to know
  // exists. The policy lives entirely in the caller; feeder only enforces
  // what's explicitly declared, keeping it a generic, use-case-agnostic
  // provider.
  for (const need of declaredNeeds ?? []) {
    if (!needs.includes(need)) needs.push(need);
  }

  // Tier-0 prompt classification (the fix for "the black hole"). When the caller
  // left the TASK unspecified — bare `auto`, or no `model` field at all (not a
  // pinned model, no explicit `auto/<class>`) — derive a task_class from THIS
  // turn's prompt so the router's task-quality scoring actually engages instead
  // of always seeing 'overall'. An EXPLICIT `auto/<class>` is honoured verbatim
  // (D1 — never overridden). `needs[]` is untouched here: it stays the hard
  // capability FLOOR (Lunk's caveat — a trivial-looking turn may still fire a
  // tool); the classifier only ADDS structural needs (vision/long_context) it
  // can prove from the content. Pure ~0ms heuristics; tier-1 (a small local
  // model) will later refine only the low-confidence residue.
  const isPinned = !!requestedModel && !isAuto;
  // Vision is a HARD capability floor derived straight from content — a user turn
  // carrying an image_url part must land on a vision-capable model regardless of
  // task_class or whether the classifier runs. Added to needs[] for any non-pinned
  // request (a pinned model bypasses routing, so the caller owns that choice).
  const hasImage = hasImageContent(messages);
  if (hasImage && !isPinned && !needs.includes('vision')) needs.push('vision');
  let effectiveTaskClass = taskClass;
  // Content-free classification reason for the request log (wsl's 2026-07-14 ask):
  // explains WHY this task_class was chosen without storing any prompt text.
  let effectiveClassifyReason: string | null = taskClass ? 'explicit task_class' : (isPinned ? 'pinned model' : null);
  if (!taskClass && !isPinned) {
    const cls = await classifyPrompt(latestUserText(messages), {
      estimatedTokens: estimatedInputTokens,
      hasImage,
      hasHistory: messages.some(m => m.role === 'assistant'),
      latencyCeilingMs: latency_ceiling_ms, // tier-1 only fires if the budget absorbs it
    });
    effectiveTaskClass = cls.taskClass;
    effectiveClassifyReason = `tier${cls.tier}: ${cls.reason}`;
    for (const n of cls.structuralNeeds) if (!needs.includes(n)) needs.push(n);
  }

  // Context handoff (ported, DISABLED unless FREELLMAPI_CONTEXT_HANDOFF=on_model_switch).
  // When routing switches models mid-conversation (failover/sticky-miss, or a
  // per-turn task_type change picking a different model), the new model has no
  // idea it is continuing someone else's task. If enabled, we inject one compact
  // system message telling it so. Fully inert when off. Pad the routing token
  // estimate for the injected message so context-window/TPM checks stay honest.
  const handoffMode = getContextHandoffMode();
  const handoffSessionKey = getSessionKey(messages, explicitSessionId);
  if (handoffMode !== 'off') recordIncomingMessages(handoffSessionKey, messages);
  const routingEstimate = estimatedTotal + (handoffMode !== 'off' && hasPriorModel(handoffSessionKey) ? HANDOFF_MAX_TOKENS : 0);

  // Explicit `model` field (that isn't the 'auto' sentinel) pins routing. If
  // the catalog has no enabled row matching the requested id, return 400 —
  // silently auto-routing to a different model would be surprising to
  // OpenAI-compatible clients. Sticky-session is the fallback when no
  // `model` field was sent at all (or the 'auto' sentinel was used).
  let preferredModel: number | undefined;
  if (requestedModel && !isAuto) {
    const pool = getPool();

    // Explicit `platform/model_id` compound pin — required whenever a bare
    // model_id collides across platforms (found live 2026-07-08: e.g.
    // gpt-oss-120b exists on both cerebras and sambanova with materially
    // different dialect/tool-support behavior — these are NOT interchangeable
    // instances). Only takes effect if the left segment is a real platform,
    // so it never misfires on a model_id that legitimately contains its own
    // slash (e.g. groq's meta-llama/llama-4-scout-17b-16e-instruct).
    let resolved: { id: number } | undefined;
    const slashIdx = requestedModel.indexOf('/');
    if (slashIdx > 0) {
      const candidatePlatform = requestedModel.slice(0, slashIdx);
      const candidateModelId = requestedModel.slice(slashIdx + 1);
      resolved = await get<{ id: number }>(pool,
        'SELECT id FROM models WHERE platform = ? AND model_id = ? AND enabled = true',
        [candidatePlatform, candidateModelId]
      );
    }

    if (resolved) {
      preferredModel = resolved.id;
    } else {
      // Bare model_id lookup. Fail closed on ambiguity (Lunk's "pinned must
      // mean truly pinned" condition) rather than silently picking whichever
      // row the DB happens to return first for a duplicated model_id.
      const matches = await all<{ id: number; platform: string }>(pool,
        'SELECT id, platform FROM models WHERE model_id = ? AND enabled = true',
        [requestedModel]
      );
      if (matches.length === 1) {
        preferredModel = matches[0].id;
      } else if (matches.length > 1) {
        logRejection('400', 'model_ambiguous', `${requestedModel} on ${matches.map(m => m.platform).join(',')}`, explicitSessionId, consumer);
        res.status(400).json({
          error: {
            message: `Model id '${requestedModel}' is ambiguous — it exists on multiple platforms (${matches.map(m => m.platform).join(', ')}). Specify 'platform/${requestedModel}' to pin the exact instance.`,
            type: 'invalid_request_error',
            code: 'model_ambiguous',
          },
        });
        return;
      } else {
        const disabled = await get<{ id: number }>(pool, 'SELECT id FROM models WHERE model_id = ?', [requestedModel]);
        const reason = disabled ? 'is disabled' : 'is not in the catalog';
        logRejection('400', 'model_not_found', `${requestedModel} ${reason}`, explicitSessionId, consumer);
        res.status(400).json({
          error: {
            message: `Model '${requestedModel}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
        return;
      }
    }
  } else {
    preferredModel = getStickyModel(messages, explicitSessionId);
  }

  const maxRetries = max_attempts ?? DEFAULT_MAX_RETRIES;
  const excludeProviderSet = exclude_providers && exclude_providers.length > 0 ? new Set(exclude_providers) : undefined;

  // Swarm anti-affinity: for a swarm-consumer request that carries a session id,
  // spread this worker onto a platform NOT held by a sibling worker, and hold it
  // for the job. A first-call (session not yet holding a lane) reserves under a
  // lock so simultaneous siblings can't race onto the same provider; later calls
  // / failover just refresh the lane. Non-swarm traffic is untouched.
  const swarmSessionKey = isSwarmConsumer(consumer) && explicitSessionId ? `session:${explicitSessionId}` : null;
  const isFirstSwarmCall = swarmSessionKey != null && !hasLane(swarmSessionKey);
  // L4 inner gate: external callers are hard-clamped to free tier regardless
  // of anything else in the request. Fleet callers have no ceiling today
  // (no paid models exist in the catalog yet — this is the enforcement
  // point ready for when one is added).
  const costTierCeiling = trustTier === 'external' ? 'free' as const : undefined;

  // Swarm per-run spend cap (RINGER, 2026-07-15). If this call belongs to a
  // swarm run that DECLARED a token budget (POST /api/swarm/budget) and the run
  // has already crossed it, refuse BEFORE routing with a TERMINAL 429 — the
  // enforcement choke point (same place the anti-affinity exclusion is applied
  // below). Terminal, not retryable: the caller (ringer) STOPS the run rather
  // than failing over. Opt-in + fail-open: a run with no declared budget, or
  // one lost to a restart, is unlimited (checkBudget returns null). See
  // services/swarmBudget.ts.
  if (isSwarmConsumer(consumer) && runId) {
    const over = checkBudget(consumer, runId);
    if (over) {
      logRejection('429', 'run_budget_exceeded', `run=${runId} spent=${over.spent} budget=${over.budget}`, explicitSessionId, consumer, runId);
      res.status(429).json({
        error: {
          message: `Run '${runId}' has exhausted its declared token budget (${over.spent}/${over.budget}). This is terminal — stop the run; retrying will not help.`,
          type: 'run_budget_exceeded',
          code: 'run_budget_exceeded',
          run_id: runId,
          spent: over.spent,
          budget: over.budget,
        },
      });
      return;
    }
  }

  // Swarm zero-progress circuit-breaker (RINGER, 2026-07-15). If this swarm
  // session has spun for LIMIT consecutive no-progress rounds (empty completions
  // + nothing appended — the degenerate-loop signature that burned 6M tokens in
  // one session), refuse further calls with a TERMINAL 429 so ringer stops the
  // session instead of letting an unbounded OpenCode loop resend context forever.
  // Backstop for the missing harness step-cap; opt-in + fail-open (see
  // services/swarmProgress.ts). Keyed on session (one OpenCode agent loop).
  if (isSwarmConsumer(consumer) && explicitSessionId) {
    const spun = checkProgress(consumer, explicitSessionId);
    if (spun) {
      logRejection('429', 'no_progress_loop', `session=${explicitSessionId} zero-output streak=${spun.streak} limit=${spun.limit}`, explicitSessionId, consumer, runId);
      res.status(429).json({
        error: {
          message: `Session '${explicitSessionId}' made ${spun.streak} consecutive no-progress rounds (empty output, no new context) — aborting a runaway agent loop. This is terminal: stop the session; retrying the same task/model will just re-spin.`,
          type: 'no_progress_loop',
          code: 'no_progress_loop',
          session_id: explicitSessionId,
          streak: spun.streak,
          limit: spun.limit,
        },
      });
      return;
    }
  }

  // Retry loop: on 429/rate limit, skip that model+key and try the next one
  const skipKeys = new Set<string>();
  let lastError: any = null;
  let lastWasRetryable = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Per-attempt monotonic timer so logged latency_ms is THIS provider call's
    // own duration, not cumulative wall-time from the start of the whole request
    // (which made a model tried late in the failover chain look slow in
    // analytics). performance.now() never regresses (unlike Date.now() on an NTP
    // step / WSL2 resume, which produced negative latency rows).
    const attemptStart = performance.now();
    let route: RouteResult;
    try {
      // Compute the sibling-held platform set at CALL time (inside the lock for
      // a first-call) so it reflects the latest assignments.
      const routeOnce = () => routeRequest({
        estimatedTokens: routingEstimate,
        skipKeys: skipKeys.size > 0 ? skipKeys : undefined,
        preferredModelDbId: preferredModel,
        excludeProviders: excludeProviderSet,
        swarmExcludeProviders: swarmSessionKey ? heldPlatformsExcluding(swarmSessionKey, consumer) : undefined,
        needs: needs.length > 0 ? needs : undefined,
        costTierCeiling,
        latencyCeilingMs: latency_ceiling_ms,
        taskClass: effectiveTaskClass,
      });
      if (swarmSessionKey && attempt === 0 && isFirstSwarmCall) {
        // First call of a swarm session: reserve platform atomically.
        route = await withAssignLock(async () => {
          const r = await routeOnce();
          recordLane(swarmSessionKey, consumer, r.platform);
          return r;
        });
      } else {
        route = await routeOnce();
        if (swarmSessionKey) recordLane(swarmSessionKey, consumer, route.platform);
      }
    } catch (err: any) {
      if (err instanceof RoutingError) {
        res.status(err.status).json({
          error: { message: err.message, type: 'routing_error', code: err.code },
        });
        return;
      }
      // Unexpected error shape — fail closed with a generic routing error.
      res.status(err.status ?? 503).json({
        error: { message: err.message, type: 'routing_error' },
      });
      return;
    }

    recordRequest(route.platform, route.modelId, route.keyId);

    // Per-attempt: if handoff is enabled and THIS attempt's model differs from
    // the session's last successful model, inject the handoff system message.
    const outMessages = handoffMode !== 'off'
      ? maybeInjectContextHandoff({ mode: handoffMode, sessionKey: handoffSessionKey, messages, selectedModelKey: `${route.platform}/${route.modelId}` }).messages
      : messages;

    try {
      if (stream) {
        // Lazy header set: pre-stream errors stay retryable (no headers sent yet);
        // mid-stream errors emit an `error` SSE frame so the client sees a real signal
        // instead of a silently truncated stream.
        let totalOutputTokens = 0;
        let streamStarted = false;
        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey, outMessages, route.modelId,
            { ...sampling, tools, tool_choice, parallel_tool_calls, response_format, reasoning_effort, context_length: route.contextLength, exclude_reasoning },
          );

          for await (const chunk of gen) {
            if (!streamStarted) {
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
              res.setHeader('X-Task-Class', effectiveTaskClass ?? 'overall');
              if (augmented) res.setHeader('X-Augmented', 'web-search');
              else if (augmentSkipped) res.setHeader('X-Augment-Skipped', augmentSkipped);
              if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
              streamStarted = true;
            }
            const text = chunk.choices[0]?.delta?.content ?? '';
            totalOutputTokens += Math.ceil(text.length / 4);
            // Stamp the RESOLVED model into the streamed body so a caller that
            // reads chunk.model (not the X-Routed-Via header — the SSE transport
            // doesn't surface headers to the body reader) gets the real served
            // model as its attribution key (wsl, 2026-07-10). Format matches the
            // header: platform/model_id. Same rationale for _task_class: Lunk's
            // footer reads it off the chunk, since headers aren't visible there.
            chunk.model = `${route.platform}/${route.modelId}`;
            (chunk as typeof chunk & { _task_class?: string | null })._task_class = effectiveTaskClass ?? null;
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }

          if (!streamStarted) {
            // Upstream returned no chunks — emit minimal successful stream.
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
          }
          res.write('data: [DONE]\n\n');
          res.end();

          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
          recordSuccess(route.modelDbId);
          setStickyModel(messages, route.modelDbId, explicitSessionId);
          if (handoffMode !== 'off') recordSuccessfulModel({ sessionKey: handoffSessionKey, modelKey: `${route.platform}/${route.modelId}` });
          logRequest(route.platform, route.modelId, 'success', estimatedInputTokens, totalOutputTokens, Math.round(performance.now() - attemptStart), null, explicitSessionId, effectiveTaskClass, consumer, needs, effectiveClassifyReason, augmented, runId, augmentSkipped);
          return;
        } catch (streamErr: any) {
          if (streamStarted) {
            // Mid-stream error — finish the SSE response cleanly instead of leaving
            // the client hanging or letting Express's default handler take over.
            // Full upstream message goes to the log; the client sees a generic
            // message so we don't leak provider internals into a partial stream.
            console.error(`[Proxy] Mid-stream error from ${route.displayName}:`, streamErr.message);
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
            try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
            logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, totalOutputTokens, Math.round(performance.now() - attemptStart), streamErr.message, explicitSessionId, effectiveTaskClass, consumer, needs, effectiveClassifyReason, augmented, runId, augmentSkipped);
            return;
          }
          // Pre-stream error — bubble to outer retry/502 handler.
          throw streamErr;
        }
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, outMessages, route.modelId,
          { ...sampling, tools, tool_choice, parallel_tool_calls, response_format, reasoning_effort, context_length: route.contextLength, exclude_reasoning },
        );

        const totalTokens = result.usage?.total_tokens ?? 0;
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId, explicitSessionId);
          if (handoffMode !== 'off') recordSuccessfulModel({ sessionKey: handoffSessionKey, modelKey: `${route.platform}/${route.modelId}` });
        void harvestQuotaHeaders(route.platform, route.modelId, route.keyId, result._rate_limit_headers);
        // Passive capability observation: record what this model demonstrably
        // DID on real traffic (returned tool_calls / honored response_format)
        // as source='observed' — the token-free live version of the probes
        // (Adam, 2026-07-10). Fire-and-forget; never blocks the response.
        void observeCapabilities(route.modelDbId, { hadTools: !!(tools && tools.length > 0), hadResponseFormat: !!response_format, hadImage: hasImage }, result);

        // Tool-call rescue (ported from upstream lib/tool-call-rescue.ts): if the
        // caller offered tools but the model emitted the call as TEXT in a training
        // dialect (Kimi/DeepSeek/Llama/Qwen styles) instead of a structured
        // tool_calls array, re-parse it into real tool_calls so the caller's agent
        // loop doesn't mistake it for a final answer and die mid-task. Tightly
        // guarded: only when tools were requested, the message has NO structured
        // tool_calls, and the content carries a dialect marker. A detected-but-
        // unparseable turn is DEAD → fail over to the next model (retryable) rather
        // than deliver gibberish.
        if (tools && tools.length > 0) {
          const msg = result.choices?.[0]?.message as (ChatMessage & { tool_calls?: unknown[] }) | undefined;
          const content = typeof msg?.content === 'string' ? msg.content : '';
          if (msg && (!msg.tool_calls || msg.tool_calls.length === 0) && content && containsDialectMarker(content)) {
            const toolNames = new Set((tools.map(t => t.function?.name).filter(Boolean)) as string[]);
            const rescue = rescueInlineToolCalls(content, toolNames);
            if (rescue.detected && rescue.calls && rescue.calls.length > 0) {
              msg.tool_calls = rescue.calls.map((c, i) => ({ id: `call_rescued_${i}`, type: 'function' as const, function: { name: c.name, arguments: c.arguments } }));
              msg.content = rescue.cleanText || null;
              if (result.choices?.[0]) result.choices[0].finish_reason = 'tool_calls';
            } else if (rescue.detected) {
              // Detected a tool-call dialect but couldn't parse it → this answer is
              // unusable; treat the model as unavailable so the retry loop fails
              // over ("unavailable" is matched by isRetryableError).
              throw Object.assign(new Error(`inline tool-call dialect unparseable from ${route.modelId} — model output unavailable, failing over`), { status: 502 });
            }
          }
        }

        // Stamp the RESOLVED model into the response body (matches X-Routed-Via)
        // so a caller reading result.model gets the real served model as its
        // attribution key for quality sampling (wsl, 2026-07-10).
        result.model = `${route.platform}/${route.modelId}`;
        // Surface the classified task_class to the caller (Adam/wsl: Lunk shows it
        // in the Discord footer). It only ever reached the DB rows before, never
        // the wire. Header for HTTP readers + body field for JSON readers.
        result._task_class = effectiveTaskClass ?? null;
        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        res.setHeader('X-Task-Class', effectiveTaskClass ?? 'overall');
        if (augmented) res.setHeader('X-Augmented', 'web-search');
              else if (augmentSkipped) res.setHeader('X-Augment-Skipped', augmentSkipped);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        res.json(result);

        logRequest(
          route.platform, route.modelId, 'success',
          result.usage?.prompt_tokens ?? 0,
          result.usage?.completion_tokens ?? 0,
          Math.round(performance.now() - attemptStart), null, explicitSessionId, effectiveTaskClass, consumer, needs, effectiveClassifyReason, augmented, runId, augmentSkipped,
        );
        return;
      }
    } catch (err: any) {
      const latency = Math.round(performance.now() - attemptStart);
      logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, latency, err.message, explicitSessionId, effectiveTaskClass, consumer, needs, effectiveClassifyReason, augmented, runId, augmentSkipped);

      lastError = err;
      const retryable = isRetryableError(err);
      lastWasRetryable = retryable;

      // FAIL OVER on ANY error, retryable or not. A single model's 403/404/400
      // (e.g. a keyed model the key can't actually access, like Ollama Cloud
      // returning 403 for a model the plan doesn't include) must NOT kill a
      // request when other models can serve it — that was a hard 502 before,
      // and the intelligence-first ordering surfaced such models to the front.
      // Skip this model+key and move on; cooldown+penalty so an erroring model
      // sinks out of the lead instead of being retried first every request.
      const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
      skipKeys.add(skipId);
      setCooldown(route.platform, route.modelId, route.keyId, 120_000);
      // Per-key-vs-per-model cooldown (ported from upstream freellmapi, 2026-07-10):
      // only DEMOTE THE MODEL (sink its routing priority) when no OTHER usable key
      // could still serve it — a single key's 429 must not sink the whole model when
      // another key is available. When another usable key exists we only cooled the
      // failing KEY above, so the very next attempt re-picks the same (still-strong)
      // model on the other key instead of failing over to a weaker model.
      const otherKeyUsable = await hasOtherUsableKey(route.platform, route.modelId, route.keyId, skipKeys);
      if (!otherKeyUsable) recordRateLimitHit(route.modelDbId);
      if (needs?.includes('tools') && isToolCapabilityMismatchError(err)) {
        void markCapabilitySuspect(route.modelDbId, 'tools');
        console.log(`[Proxy] LIVE CAPABILITY REGRESSION: ${route.displayName} was measured tools=true but rejected a tool-calling request — marked suspect for re-probe`);
      }
      // Vision demote (relaxed vision gate, Adam 2026-07-13): a declared-vision
      // model that gives a GENUINE image rejection (not a transient 429/timeout)
      // is marked vision=false so the router stops routing images there. The
      // request still fails over to the next candidate this attempt.
      if (hasImage && isVisionRejectionError(err)) {
        void recordVisionUnsupported(route.modelDbId, err.message ?? 'image content rejected');
        console.log(`[Proxy] VISION DEMOTE: ${route.displayName} rejected image content — marked vision=false (declared→observed-false)`);
      }
      // Auto-bench a model a live request proved UNREACHABLE (403/404/model-
      // not-found = the key can't serve it — persistent, not transient). Stops
      // it leading + failing over on every request. Never benches on a 400
      // (that's request-shaped, not model-fatal).
      if (!retryable && isUnreachableError(err)) {
        void benchUnreachableModel(getPool(), route.modelDbId, `${route.displayName}: ${err.message}`);
        console.log(`[Proxy] AUTO-BENCH (unreachable): ${route.displayName} — ${err.message.slice(0, 60)}`);
      }
      // Quota parking: a daily/tier quota-exhausted 429 parks the model for hours
      // (see setQuotaExhausted) instead of the 90s transient cooldown, so an
      // exhausted free-tier model stops churning retries all day. The request
      // still fails over to the next candidate this attempt.
      if (isQuotaExhaustionError(err)) {
        void setQuotaExhausted(getPool(), route.modelDbId, `${route.displayName}: ${err.message}`);
        console.log(`[Proxy] QUOTA-PARK: ${route.displayName} — ${err.message.slice(0, 60)}`);
      }
      console.log(`[Proxy] ${retryable ? '' : '(non-retryable) '}${err.message.slice(0, 60)} from ${route.displayName}, falling back (attempt ${attempt + 1}/${maxRetries})`);
      continue;
    }
  }

  // Exhausted all attempts. If the last failure was a genuine provider error
  // (not a rate limit), surface 502 so a caller can tell "everything broke" from
  // "everything's throttled, retry later" (429, which Hermes's fallback keys on).
  if (lastError && !lastWasRetryable) {
    res.status(502).json({
      error: { message: `All models failed; last provider error: ${lastError?.message}`, type: 'provider_error' },
    });
    return;
  }
  res.status(429).json({
    error: {
      message: `All models rate-limited after ${maxRetries} attempts. Last: ${lastError?.message}`,
      type: 'rate_limit_error',
    },
  });
});

// Fire-and-forget: callers don't await this (logging must never block the
// response), so all errors are caught internally rather than rejecting.
async function logRequest(
  platform: string,
  modelId: string,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
  sessionId?: string,
  taskClass?: string | null,
  consumer?: string | null,
  needs?: string[] | null,
  classifyReason?: string | null,
  augmented?: boolean,
  runId?: string | null,
  augmentSkipped?: string | null,
) {
  // Book the tokens against this call's swarm run (no-op unless the run declared
  // a budget) BEFORE the insert, so a DB write failure can't skip metering.
  recordSpend(consumer, runId, (inputTokens ?? 0) + (outputTokens ?? 0));
  // Feed the zero-progress circuit-breaker (no-op unless a swarm session): a
  // completed round's token shape tells us if the agent loop is making progress.
  recordProgress(consumer, sessionId, inputTokens ?? 0, outputTokens ?? 0);
  try {
    await run(getPool(), `
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, session_id, task_class, consumer, needs, classify_reason, augmented, run_id, augment_skipped)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [platform, modelId, status, inputTokens, outputTokens, Math.max(0, Math.round(latencyMs)), error, sessionId ?? null, taskClass ?? null, consumer ?? null, needs && needs.length > 0 ? needs.join(',') : null, classifyReason ?? null, augmented ?? false, runId ?? null, augmentSkipped ?? null]);
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}

// Log a PRE-ROUTING 4xx rejection (bad body, model-not-found/ambiguous) so a
// restart-dropped stream or a worker's malformed call is OBSERVABLE in
// /api/requests instead of vanishing (only post-routing outcomes were logged
// before, so a downstream 400 from a dropped in-flight stream left no trace).
// Sentinel platform='rejected'; the HTTP status goes in `status` and the reason
// code/message in `error`. Flagged is_probe=true so it's SYNTHETIC — excluded
// from real-traffic analytics by default (probeFilter) but visible on
// /api/requests + the agent wall. Content-free: no prompt/body text.
async function logRejection(
  code: string,          // HTTP status as string, e.g. '400'
  reason: string,        // machine reason, e.g. 'model_not_found' / 'invalid_body'
  detail: string | null, // short message (no prompt text)
  sessionId?: string,
  consumer?: string | null,
  runId?: string | null,
) {
  try {
    await run(getPool(), `
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, session_id, consumer, is_probe, run_id)
      VALUES ('rejected', ?, ?, 0, 0, 0, ?, ?, ?, true, ?)
    `, [reason, code, detail ? detail.slice(0, 300) : reason, sessionId ?? null, consumer ?? null, runId ?? null]);
  } catch (e) {
    console.error('Failed to log rejection:', e);
  }
}
