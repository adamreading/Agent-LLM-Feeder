import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@freellmapi/shared/types.js';

export interface ResponseFormat {
  type: 'json_object' | 'json_schema';
  json_schema?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

// Neutral reasoning-effort request — 'none' means "answer directly, no
// extended thinking". Each provider adapter translates this into its own
// wire dialect (see DialectConfig in openai-compat.ts); a model with no known
// dialect for this is excluded from routing eligibility rather than having
// the field silently dropped.
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
  response_format?: ResponseFormat;
  reasoning_effort?: ReasoningEffort;
  // The context window the router resolved this request against (its own
  // token estimate, capped by the routed model's declared context_window).
  // Providers whose backend defaults to a SMALL context regardless of the
  // model's real capacity (Ollama's OpenAI-compat endpoint defaults
  // num_ctx=2048 and silently truncates past it — ob-claude review,
  // 2026-07-07) must be explicitly told to use this much, or "the model can
  // do 64k" and "the model was TOLD to use 64k" silently diverge — the same
  // failure class as an unhonored reasoning/json_mode field, just quieter
  // (wrong output, not a 400).
  context_length?: number;
  // Opt-in reasoning suppression (Adam's call, 2026-07-08, after Chinese
  // chain-of-thought from deepseek-v4-pro/qwen3-coder leaked into Lunk's
  // Discord output). Generic and caller-declared — NOT a feeder-imposed rule,
  // so any consumer opts in independently (Lunk for persona; OB even more so,
  // since folded CoT silently corrupts its structured-extraction JSON). When
  // true: never fold reasoning_content/reasoning into content, and strip both
  // fields from the returned message so raw CoT can't reach the consumer. If a
  // model produced ONLY reasoning (empty content), the caller opted out of the
  // only text there was — content stays empty by design, rather than leaking.
  exclude_reasoning?: boolean;
}

export type ReasoningDialect =
  | 'openai_reasoning_effort' // flat `reasoning_effort: "none"|"low"|...` (e.g. Groq gpt-oss)
  | 'nested_reasoning_effort' // `reasoning: { effort: "none"|... }` (Ollama)
  | 'chat_template_enable_thinking'; // `chat_template_kwargs: { enable_thinking: boolean }` (NVIDIA NIM)

export type ContextLengthDialect =
  | 'ollama_num_ctx'; // `options: { num_ctx: N }` — Ollama's native param, passed through its OpenAI-compat layer

// Provider-level capability declaration — the router's capability filter
// (services/router.ts) checks these directly. Never assume; every `true`/
// dialect value here must correspond to real, tested wire-format code in
// that provider's chatCompletion/streamChatCompletion.
export interface DialectConfig {
  jsonMode?: boolean;
  reasoning?: ReasoningDialect;
  /** Set ONLY when a provider genuinely accepts a per-request context-length
   * override on the wire. Confirmed NOT true for Ollama via its
   * /v1/chat/completions endpoint (no such param exists there at all — P2
   * review, 2026-07-07); left unset on that registration deliberately. Real,
   * tested infrastructure (openai-compat.test.ts) for a future provider that
   * does support this, not a general-purpose escape hatch. */
  contextLength?: ContextLengthDialect;
}

export abstract class BaseProvider {
  abstract readonly platform: Platform;
  abstract readonly name: string;
  /** Capabilities this provider instance can actually wire correctly. Defaults to none. */
  readonly dialect: DialectConfig = {};

  abstract chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse>;

  abstract streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk>;

  abstract validateKey(apiKey: string): Promise<boolean>;

  // P3: several providers (Groq, OpenRouter, Mistral, Cerebras confirmed by
  // prior design research) return these on every response, win-or-lose —
  // real, provider-declared quota truth rather than our own estimate. A
  // provider that doesn't send them yields undefined; the harvester treats
  // that as "no data," never a false zero.
  protected static readonly RATE_LIMIT_HEADER_NAMES = [
    'x-ratelimit-limit-requests',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-remaining-tokens',
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
  ] as const;

  // Defensive against `headers` being absent or non-standard: quota
  // telemetry must never be the reason a real completion request fails
  // (same principle as proxy.ts's fire-and-forget request logger).
  protected extractRateLimitHeaders(headers: unknown): Record<string, string> | undefined {
    if (!headers || typeof (headers as Headers).get !== 'function') return undefined;
    const found: Record<string, string> = {};
    for (const name of BaseProvider.RATE_LIMIT_HEADER_NAMES) {
      const value = (headers as Headers).get(name);
      if (value != null) found[name] = value;
    }
    return Object.keys(found).length > 0 ? found : undefined;
  }

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 15000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  protected makeId(): string {
    return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
