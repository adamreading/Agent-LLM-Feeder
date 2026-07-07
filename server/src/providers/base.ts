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
}

export type ReasoningDialect =
  | 'openai_reasoning_effort' // flat `reasoning_effort: "none"|"low"|...` (e.g. Groq gpt-oss)
  | 'nested_reasoning_effort' // `reasoning: { effort: "none"|... }` (Ollama)
  | 'chat_template_enable_thinking'; // `chat_template_kwargs: { enable_thinking: boolean }` (NVIDIA NIM)

// Provider-level capability declaration — the router's capability filter
// (services/router.ts) checks these directly. Never assume; every `true`/
// dialect value here must correspond to real, tested wire-format code in
// that provider's chatCompletion/streamChatCompletion.
export interface DialectConfig {
  jsonMode?: boolean;
  reasoning?: ReasoningDialect;
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
