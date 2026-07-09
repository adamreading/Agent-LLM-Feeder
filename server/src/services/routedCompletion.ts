import type { ChatMessage } from '@freellmapi/shared/types.js';
import { routeRequest, recordSuccess, recordRateLimitHit, RoutingError } from './router.js';
import { setCooldown } from './ratelimit.js';

// In-process "route a chat completion through feeder's OWN router" — the same
// intelligence/task-quality/health/failover selection the public /v1 endpoint
// uses, but callable directly by internal jobs (research writer, future probes)
// without an HTTP hop or the unified key. This is how feeder DOGFOODS its own
// routing: the research writer is no longer a single pinned model that stalls
// the moment it rate-limits — it's `auto` with a task tag, so it fails over
// across the pool and always uses the best AVAILABLE writer.

export interface RoutedChatOptions {
  taskClass?: string | null;         // e.g. 'research' → picks a strong instruction-follower
  needs?: string[];                  // hard capability filter (e.g. ['json_mode'])
  maxAttempts?: number;              // failover hops before giving up
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
  excludeReasoning?: boolean;
}

export interface RoutedChatResult { content: string | null; platform: string; modelId: string }

// Returns null when nothing is eligible / everything's rate-limited or errored —
// callers treat that as "no result", never a thrown 500.
export async function routedChat(messages: ChatMessage[], opts: RoutedChatOptions = {}): Promise<RoutedChatResult | null> {
  const skipKeys = new Set<string>();
  const maxAttempts = opts.maxAttempts ?? 6;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let route;
    try {
      route = await routeRequest({
        needs: opts.needs,
        taskClass: opts.taskClass,
        skipKeys: skipKeys.size > 0 ? skipKeys : undefined,
      });
    } catch (err) {
      // NO_ELIGIBLE_MODEL / ALL_RATE_LIMITED — no writer available right now.
      if (err instanceof RoutingError) return null;
      throw err;
    }

    try {
      const res = await route.provider.chatCompletion(route.apiKey, messages, route.modelId, {
        max_tokens: opts.maxTokens ?? 600,
        response_format: opts.responseFormat,
        exclude_reasoning: opts.excludeReasoning,
        context_length: route.contextLength,
      });
      recordSuccess(route.modelDbId);
      const content = res.choices?.[0]?.message?.content;
      return { content: typeof content === 'string' ? content : null, platform: route.platform, modelId: route.modelId };
    } catch {
      // Fail over to the next candidate (same discipline as the proxy): cooldown
      // + penalty so a struggling model sinks, then re-route fresh next attempt.
      skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
      setCooldown(route.platform, route.modelId, route.keyId, 120_000);
      recordRateLimitHit(route.modelDbId);
    }
  }
  return null;
}
