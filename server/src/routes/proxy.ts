import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { routeRequest, recordRateLimitHit, recordSuccess, RoutingError, type RouteResult, type CapabilityNeed } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown } from '../services/ratelimit.js';
import { harvestQuotaHeaders } from '../services/quotaHarvest.js';
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

async function resolveTrustTier(req: Request): Promise<{ tier: TrustTier; authorized: boolean }> {
  const isLocal = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  if (isLocal) return { tier: 'fleet', authorized: true };

  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return { tier: 'external', authorized: false };

  const row = await get<{ trust_tier: string }>(getPool(),
    'SELECT trust_tier FROM consumer_keys WHERE key_hash = ? AND enabled = true',
    [hashToken(token)]
  );
  if (row) return { tier: row.trust_tier === 'fleet' ? 'fleet' : 'external', authorized: true };

  // Legacy fallback: a caller presenting the raw unified_api_key directly
  // (pre-consumer_keys migration path). Migrated installs already have this
  // key's hash IN consumer_keys as a 'fleet' row, so this only matters if
  // that row was somehow removed — kept for defense in depth, not the
  // primary path.
  const unifiedKey = await getUnifiedApiKey();
  if (timingSafeStringEqual(token, unifiedKey)) return { tier: 'fleet', authorized: true };

  return { tier: 'external', authorized: false };
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

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: z.string(),
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
  session_id: z.string().optional(),
  user: z.string().optional(), // OpenAI-standard field, also accepted as a sticky-session carrier
});

function isRetryableError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error');
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
  const start = Date.now();

  // L4 outer gate: resolve trust tier before anything else. Non-local
  // requests without a recognized token are rejected exactly as before.
  const { tier: trustTier, authorized } = await resolveTrustTier(req);
  if (!authorized) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return;
  }

  // Validate request
  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
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
  } = parsed.data;
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

  // Token estimation is intentionally a heuristic (~4 chars per token). Used
  // for routing decisions (skip a model whose budget is too small) and for
  // streaming bookkeeping where the provider doesn't echo a final usage count.
  // Non-streaming requests reconcile against the provider's real `usage` block
  // (see line ~340). Streaming will drift from real consumption — accepted
  // tradeoff because per-request usage isn't always returned mid-stream.
  const estimatedInputTokens = messages.reduce((sum, m) => {
    if (typeof m.content !== 'string') return sum;
    return sum + Math.ceil(m.content.length / 4);
  }, 0);
  const estimatedTotal = estimatedInputTokens + (max_tokens ?? 1000);

  // Tier-0 heuristics: derive capability needs directly from the request's
  // own declared fields — no LLM, no task_class tuple required for this.
  const needs: CapabilityNeed[] = [];
  if (response_format) needs.push('json_mode');
  if (reasoning_effort) needs.push('reasoning_control');
  if (tools && tools.length > 0) needs.push('tools');

  const explicitSessionId = session_id ?? user;
  const { taskClass, isAuto } = parseModelField(requestedModel);

  // Explicit `model` field (that isn't the 'auto' sentinel) pins routing. If
  // the catalog has no enabled row matching the requested id, return 400 —
  // silently auto-routing to a different model would be surprising to
  // OpenAI-compatible clients. Sticky-session is the fallback when no
  // `model` field was sent at all (or the 'auto' sentinel was used).
  let preferredModel: number | undefined;
  if (requestedModel && !isAuto) {
    const pool = getPool();
    const enabled = await get<{ id: number }>(pool, 'SELECT id FROM models WHERE model_id = ? AND enabled = true', [requestedModel]);
    if (enabled) {
      preferredModel = enabled.id;
    } else {
      const disabled = await get<{ id: number }>(pool, 'SELECT id FROM models WHERE model_id = ?', [requestedModel]);
      const reason = disabled ? 'is disabled' : 'is not in the catalog';
      res.status(400).json({
        error: {
          message: `Model '${requestedModel}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      });
      return;
    }
  } else {
    preferredModel = getStickyModel(messages, explicitSessionId);
  }

  const maxRetries = max_attempts ?? DEFAULT_MAX_RETRIES;
  const excludeProviderSet = exclude_providers && exclude_providers.length > 0 ? new Set(exclude_providers) : undefined;
  // L4 inner gate: external callers are hard-clamped to free tier regardless
  // of anything else in the request. Fleet callers have no ceiling today
  // (no paid models exist in the catalog yet — this is the enforcement
  // point ready for when one is added).
  const costTierCeiling = trustTier === 'external' ? 'free' as const : undefined;

  // Retry loop: on 429/rate limit, skip that model+key and try the next one
  const skipKeys = new Set<string>();
  let lastError: any = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let route: RouteResult;
    try {
      route = await routeRequest({
        estimatedTokens: estimatedTotal,
        skipKeys: skipKeys.size > 0 ? skipKeys : undefined,
        preferredModelDbId: preferredModel,
        excludeProviders: excludeProviderSet,
        needs: needs.length > 0 ? needs : undefined,
        costTierCeiling,
        latencyCeilingMs: latency_ceiling_ms,
      });
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

    try {
      if (stream) {
        // Lazy header set: pre-stream errors stay retryable (no headers sent yet);
        // mid-stream errors emit an `error` SSE frame so the client sees a real signal
        // instead of a silently truncated stream.
        let totalOutputTokens = 0;
        let streamStarted = false;
        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey, messages, route.modelId,
            { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls, response_format, reasoning_effort, context_length: route.contextLength },
          );

          for await (const chunk of gen) {
            if (!streamStarted) {
              res.setHeader('Content-Type', 'text/event-stream');
              res.setHeader('Cache-Control', 'no-cache');
              res.setHeader('Connection', 'keep-alive');
              res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
              if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
              streamStarted = true;
            }
            const text = chunk.choices[0]?.delta?.content ?? '';
            totalOutputTokens += Math.ceil(text.length / 4);
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
          logRequest(route.platform, route.modelId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null, explicitSessionId, taskClass);
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
            logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, streamErr.message, explicitSessionId, taskClass);
            return;
          }
          // Pre-stream error — bubble to outer retry/502 handler.
          throw streamErr;
        }
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, messages, route.modelId,
          { temperature, max_tokens, top_p, tools, tool_choice, parallel_tool_calls, response_format, reasoning_effort, context_length: route.contextLength },
        );

        const totalTokens = result.usage?.total_tokens ?? 0;
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId, explicitSessionId);
        void harvestQuotaHeaders(route.platform, route.modelId, route.keyId, result._rate_limit_headers);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        res.json(result);

        logRequest(
          route.platform, route.modelId, 'success',
          result.usage?.prompt_tokens ?? 0,
          result.usage?.completion_tokens ?? 0,
          Date.now() - start, null, explicitSessionId, taskClass,
        );
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      logRequest(route.platform, route.modelId, 'error', estimatedInputTokens, 0, latency, err.message, explicitSessionId, taskClass);

      if (isRetryableError(err)) {
        // Put this model+key on cooldown and try the next one
        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        setCooldown(route.platform, route.modelId, route.keyId, 120_000);
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        console.log(`[Proxy] ${err.message.slice(0, 60)} from ${route.displayName}, falling back (attempt ${attempt + 1}/${maxRetries})`);
        continue;
      }

      // Non-retryable error (auth, 4xx, etc.): don't retry
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${err.message}`,
          type: 'provider_error',
        },
      });
      return;
    }
  }

  // Exhausted all retries
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
) {
  try {
    await run(getPool(), `
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, session_id, task_class)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [platform, modelId, status, inputTokens, outputTokens, latencyMs, error, sessionId ?? null, taskClass ?? null]);
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}
