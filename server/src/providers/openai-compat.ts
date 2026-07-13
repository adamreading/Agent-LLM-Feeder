import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions, type DialectConfig, type ReasoningDialect, type ContextLengthDialect } from './base.js';

/** Copy only the defined values from `params` onto `body`. Keeps unset sampling
 * params out of the request entirely (an explicit `undefined` would otherwise be
 * dropped by JSON.stringify anyway, but omitting keeps the body clean and makes
 * the dropParams filter and body inspection meaningful). */
function assignIfDefined(body: Record<string, unknown>, params: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) body[k] = v;
  }
}

function applyReasoningDialect(body: Record<string, unknown>, effort: string, dialect?: ReasoningDialect): void {
  if (!dialect) return; // no known dialect — caller-level capability filtering must have already excluded this model
  if (dialect === 'openai_reasoning_effort') body.reasoning_effort = effort;
  else if (dialect === 'nested_reasoning_effort') body.reasoning = { effort };
  else if (dialect === 'chat_template_enable_thinking') {
    body.chat_template_kwargs = { enable_thinking: effort !== 'none' };
  }
}

function applyContextLengthDialect(body: Record<string, unknown>, contextLength: number, dialect?: ContextLengthDialect): void {
  if (!dialect) return; // no dialect declared — this provider's context handling is assumed to need no explicit hint
  if (dialect === 'ollama_num_ctx') {
    body.options = { ...(body.options as Record<string, unknown> | undefined ?? {}), num_ctx: contextLength };
  }
}

/**
 * Generic provider for platforms that use an OpenAI-compatible API.
 * Covers: Groq, Cerebras, SambaNova, NVIDIA NIM, Mistral, OpenRouter,
 * GitHub Models, Zhipu, Ollama, Kilo, Pollinations, LLM7.
 */
export class OpenAICompatProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly validateUrl?: string;
  /** Per-provider HTTP timeout override. Cloud APIs finish in ~15s; locally-hosted
   * inference (llama.cpp / vLLM on CPU) can take 30-120s for long prompts. Default 15000. */
  private readonly timeoutMs: number;
  readonly dialect: DialectConfig;

  constructor(opts: {
    platform: Platform;
    name: string;
    baseUrl: string;
    extraHeaders?: Record<string, string>;
    validateUrl?: string;
    timeoutMs?: number;
    dialect?: DialectConfig;
  }) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.validateUrl = opts.validateUrl;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.dialect = opts.dialect ?? {};
  }

  private buildBody(messages: ChatMessage[], modelId: string, options: CompletionOptions | undefined, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      parallel_tool_calls: options?.parallel_tool_calls,
    };
    if (stream) body.stream = true;
    // Standard OpenAI sampling passthrough — each emitted only when the caller
    // set it, so an unset field is never sent (byte-identical body to before for
    // callers that don't use these). A provider that rejects a specific one is
    // handled by dialect.dropParams below.
    assignIfDefined(body, {
      frequency_penalty: options?.frequency_penalty,
      presence_penalty: options?.presence_penalty,
      seed: options?.seed,
      stop: options?.stop,
      n: options?.n,
      logit_bias: options?.logit_bias,
      logprobs: options?.logprobs,
      top_logprobs: options?.top_logprobs,
      max_completion_tokens: options?.max_completion_tokens,
    });
    // Vendor sampling params only for providers documented to accept them.
    if (this.dialect.extendedSampling) {
      assignIfDefined(body, {
        top_k: options?.top_k,
        min_p: options?.min_p,
        repetition_penalty: options?.repetition_penalty,
      });
    }
    // Dialect-gated: only emitted when this instance declares support. Router-
    // level capability filtering is the actual gate; this is defense in depth.
    if (options?.response_format && this.dialect.jsonMode) {
      body.response_format = options.response_format;
    }
    if (options?.reasoning_effort) {
      applyReasoningDialect(body, options.reasoning_effort, this.dialect.reasoning);
    }
    if (options?.context_length) {
      applyContextLengthDialect(body, options.context_length, this.dialect.contextLength);
    }
    // Escape hatch (applied LAST): strip any params this provider is known to
    // reject, so broad passthrough can't turn into a 400 on a strict backend.
    for (const p of this.dialect.dropParams ?? []) delete body[p];
    return body;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify(this.buildBody(messages, modelId, options, false)),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    normalizeChoices(data, options?.exclude_reasoning ?? false);
    data._routed_via = { platform: this.platform, model: modelId };
    data._rate_limit_headers = this.extractRateLimitHeaders(res.headers);
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...this.extraHeaders,
      },
      body: JSON.stringify(this.buildBody(messages, modelId, options, true)),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`${this.name} API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          const chunk = JSON.parse(data) as ChatCompletionChunk;
          // Strip reasoning deltas when the caller opted out — streaming yields
          // raw chunks, so without this a Chinese-CoT reasoning delta would
          // still reach the consumer even though the non-streaming path guards
          // it. Same opt-in contract, both paths.
          if (options?.exclude_reasoning) {
            for (const ch of chunk.choices ?? []) {
              const delta = ch.delta as { reasoning_content?: string; reasoning?: string } | undefined;
              if (delta) { delete delta.reasoning_content; delete delta.reasoning; }
            }
          }
          yield chunk;
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Note: transport errors (DNS / timeout / TLS) propagate to the caller.
    // health.ts catches them and marks status='error' WITHOUT incrementing
    // the consecutive-failure counter — only confirmed 401/403 disables a key.
    const url = this.validateUrl ?? `${this.baseUrl}/models`;
    const res = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...this.extraHeaders,
      },
    }, 10000);
    return res.status !== 401 && res.status !== 403;
  }
}

/**
 * Some providers (Z.ai glm-4.5-flash, Cloudflare DeepSeek-R1-distill, others)
 * return reasoning models' actual answer in `message.reasoning_content` with
 * `message.content === ""`. Fold reasoning_content into content so OpenAI-
 * compatible clients see a non-empty assistant message.
 *
 * Other providers (Mistral magistral-medium) return `message.content` as an
 * array of text segments instead of a string. Flatten to string.
 *
 * `excludeReasoning` (caller opt-in, 2026-07-08): when set, raw reasoning must
 * NOT reach the consumer — so we neither fold it into content nor return the
 * reasoning fields. This is the load-bearing feeder-side guard against the
 * Chinese-CoT-leak that rolled Lunk back; the fold otherwise actively surfaces
 * raw reasoning whenever a model leaves content empty.
 */
function normalizeChoices(data: ChatCompletionResponse, excludeReasoning: boolean): void {
  for (const choice of data.choices ?? []) {
    const msg = choice.message as ChatMessage & {
      reasoning_content?: string;
      reasoning?: string;
      content: unknown;
    };
    // Flatten array content (Mistral magistral) → join text segments.
    if (Array.isArray(msg.content)) {
      msg.content = (msg.content as Array<{ text?: string; type?: string }>)
        .map(seg => (typeof seg === 'string' ? seg : (seg.text ?? '')))
        .join('');
    }

    if (excludeReasoning) {
      // Caller opted out of reasoning entirely: never fold, and strip both
      // possible field names so no raw CoT is returned. If the model produced
      // only reasoning (empty content), content stays empty by the caller's
      // own choice — an empty answer is preferable to a leaked one.
      delete msg.reasoning_content;
      delete msg.reasoning;
      continue;
    }

    // Fold reasoning into content if content is empty AND there are no
    // tool_calls. With tool_calls present, content=null is the correct OpenAI
    // shape; folding reasoning would confuse clients that branch on content.
    // Field naming varies by provider: Z.ai uses `reasoning_content`, Ollama
    // uses `reasoning`. Prefer `reasoning_content` when both are set.
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    if (!hasToolCalls && (msg.content === '' || msg.content == null)) {
      const fold = (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0)
        ? msg.reasoning_content
        : (typeof msg.reasoning === 'string' && msg.reasoning.length > 0 ? msg.reasoning : null);
      if (fold !== null) msg.content = fold;
    }
  }
}
