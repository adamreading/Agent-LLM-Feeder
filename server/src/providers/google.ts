import type {
  ChatMessage,
  ChatContentPart,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
  TokenUsage,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions, type DialectConfig } from './base.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Gemini 3 thinking models REJECT a follow-up (400 "Function call is missing a
// thought_signature in functionCall") whose prior functionCall omits the
// thoughtSignature Gemini issued. That signature is a NON-STANDARD extension to
// the OpenAI tool_call schema, so it does not reliably survive a client's
// round-trip: one client carries it top-level (`thought_signature`), another
// nests it under `extra_content`, and if the field names don't line up on BOTH
// legs it silently vanishes and the next turn 400s.
//
// Feeder is the translation/resilience layer, so it self-heals instead of
// depending on any client's field shape: remember the signature keyed by the
// tool_call id we hand out when we EXTRACT it, and re-inject it on echo-back if
// the client didn't return one. The id round-trips verbatim (client echoes the
// exact id feeder gave it), so the key always matches — robust to ANY client.
const sigCache = new Map<string, { sig: string; ts: number }>();
const SIG_TTL_MS = 30 * 60 * 1000; // matches the proxy sticky-session TTL
const SIG_MAX = 2000;

function rememberSig(id: string, sig: string | undefined): void {
  if (!sig) return;
  sigCache.set(id, { sig, ts: Date.now() });
  if (sigCache.size > SIG_MAX) {
    const cutoff = Date.now() - SIG_TTL_MS;
    for (const [k, v] of sigCache) if (v.ts < cutoff) sigCache.delete(k);
    while (sigCache.size > SIG_MAX) {
      const oldest = sigCache.keys().next().value;
      if (oldest === undefined) break;
      sigCache.delete(oldest);
    }
  }
}

function recallSig(id: string): string | undefined {
  const e = sigCache.get(id);
  if (!e) return undefined;
  if (Date.now() - e.ts > SIG_TTL_MS) { sigCache.delete(id); return undefined; }
  return e.sig;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: unknown;
  };
  functionResponse?: {
    id?: string;
    name?: string;
    response?: unknown;
  };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { value: raw };
  }
}

function normalizeGeminiArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  return JSON.stringify(args ?? {});
}

function toGeminiFinishReason(finishReason?: string): string {
  const r = (finishReason ?? '').toUpperCase();
  if (!r) return 'stop';
  if (r === 'MAX_TOKENS') return 'length';
  if (r === 'SAFETY' || r === 'RECITATION' || r === 'BLOCKLIST' || r === 'PROHIBITED_CONTENT' || r === 'SPII') {
    return 'content_filter';
  }
  return 'stop';
}

// JSON-schema keywords Google's function-declaration + responseSchema parser
// (a strict OpenAPI-3.0 subset) rejects outright with a 400. Found live
// 2026-07-08 (wsl, on a real Lunk Discord turn): Lunk's real tool schemas use
// `additionalProperties` — valid JSON-schema, accepted by every OTHER provider
// — and Gemini 400s ("Unknown name 'additionalProperties'"), 502ing the whole
// turn and forcing a degraded local fallback. windows confirmed the same class
// hits json_mode responseSchema for a consumer's structured-extraction call-sites.
// Gemini genuinely tool-calls and honors JSON schema; its parser just can't
// tolerate these keywords, so we strip them before dispatch — the dialect/
// compat layer's job, exactly like the reasoning-dialect translation. This
// helps ALL consumers (agents, structured-extraction jobs, Open WebUI), not
// just one, so it lives here in the provider adapter, not in any caller.
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  'additionalProperties', 'unevaluatedProperties', 'patternProperties', 'additionalItems',
  'unevaluatedItems', '$schema', '$id', '$ref', '$defs', 'definitions', '$comment', '$anchor',
]);

// Recursively strip the unsupported keywords. Careful with `properties`: its
// child keys are arbitrary PROPERTY NAMES, not schema keywords, so a parameter
// legitimately named e.g. "additionalProperties" must survive — only strip a
// blocklisted key when it's acting as a schema keyword, never as a prop name.
export function sanitizeSchemaForGemini(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchemaForGemini);
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[propName] = sanitizeSchemaForGemini(propSchema); // recurse into the schema, keep the name verbatim
      }
      out[key] = props;
      continue;
    }
    out[key] = sanitizeSchemaForGemini(value);
  }
  return out;
}

function toGeminiTools(tools?: ChatToolDefinition[]): Array<{ functionDeclarations: Array<Record<string, unknown>> }> | undefined {
  if (!tools || tools.length === 0) return undefined;

  return [{
    functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: sanitizeSchemaForGemini(t.function.parameters),
    })),
  }];
}

// Gemini's native JSON mode: responseMimeType (+ optional responseSchema for
// the json_schema variant). Reasoning control is NOT implemented here — no
// confirmed dialect for Gemini's thinking-budget controls yet; requests
// declaring reasoning_effort are capability-filtered away from Google models
// until that's verified (see providers/index.ts).
function toGeminiGenerationConfig(options?: CompletionOptions): Record<string, unknown> {
  const config: Record<string, unknown> = {
    temperature: options?.temperature,
    maxOutputTokens: options?.max_tokens,
    topP: options?.top_p,
  };
  if (options?.response_format?.type === 'json_object') {
    config.responseMimeType = 'application/json';
  } else if (options?.response_format?.type === 'json_schema' && options.response_format.json_schema) {
    config.responseMimeType = 'application/json';
    // Same strict-parser sanitize as tool parameters (a consumer's
    // structured-extraction response schemas hit the identical rejection).
    config.responseSchema = sanitizeSchemaForGemini(options.response_format.json_schema.schema);
  }
  return config;
}

function toGeminiToolConfig(toolChoice?: ChatToolChoice): { functionCallingConfig: Record<string, unknown> } | undefined {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === 'string') {
    const mode =
      toolChoice === 'none'
        ? 'NONE'
        : toolChoice === 'required'
          ? 'ANY'
          : 'AUTO';
    return { functionCallingConfig: { mode } };
  }

  return {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: [toolChoice.function.name],
    },
  };
}

// Parse a data: URI into a Gemini inlineData part. Returns null for non-data
// URIs (http(s) URLs): Gemini's generateContent needs inline base64, whereas
// OpenAI-compat vision models accept URLs natively via passthrough — so a
// URL-image request routes best to those, not Gemini.
function dataUriToInlineData(url: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(url);
  if (!m) return null;
  const mimeType = m[1] || 'application/octet-stream';
  const isBase64 = !!m[2];
  const data = isBase64
    ? m[3]
    : Buffer.from(decodeURIComponent(m[3]), 'utf8').toString('base64');
  return { mimeType, data };
}

// A user turn's content → Gemini parts. String → one text part. Array (vision) →
// text parts kept, image_url parts converted to inlineData when they're data:
// URIs (http(s) URL images can't inline into Gemini and are dropped here).
function userContentToGeminiParts(content: string | ChatContentPart[] | null): GeminiPart[] {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: '' }];
  const parts: GeminiPart[] = [];
  for (const p of content) {
    if (p.type === 'text') {
      parts.push({ text: p.text });
    } else if (p.type === 'image_url') {
      const inline = dataUriToInlineData(p.image_url.url);
      if (inline) parts.push({ inlineData: inline });
    }
  }
  return parts.length > 0 ? parts : [{ text: '' }];
}

// Translate OpenAI messages to Gemini format
function toGeminiContents(messages: ChatMessage[]) {
  const systemMessages = messages
    .filter(m => m.role === 'system' && typeof m.content === 'string' && m.content.length > 0)
    .map(m => m.content as string);

  const toolNameByCallId = new Map<string, string>();
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      toolNameByCallId.set(tc.id, tc.function.name);
    }
  }

  const contents = messages
    .filter(m => m.role !== 'system')
    .map((m): { role: 'user' | 'model'; parts: GeminiPart[] } | null => {
      if (m.role === 'assistant') {
        const parts: GeminiPart[] = [];

        if (typeof m.content === 'string' && m.content.length > 0) {
          parts.push({ text: m.content });
        }

        for (const call of m.tool_calls ?? []) {
          parts.push({
            // Self-heal: prefer the client-echoed signature, else the one we
            // cached when we handed this tool_call id out (see sigCache).
            thoughtSignature: call.thought_signature ?? recallSig(call.id),
            functionCall: {
              id: call.id,
              name: call.function.name,
              args: safeParseObject(call.function.arguments),
            },
          });
        }

        if (parts.length === 0) return null;
        return {
          role: 'model',
          parts,
        };
      }

      if (m.role === 'tool') {
        const toolCallId = m.tool_call_id;
        if (!toolCallId) return null;

        const toolName = m.name ?? toolNameByCallId.get(toolCallId) ?? 'tool';
        const response = safeParseObject(typeof m.content === 'string' ? m.content : '');

        return {
          role: 'user',
          parts: [{
            functionResponse: {
              id: toolCallId,
              name: toolName,
              response,
            },
          }],
        };
      }

      return {
        role: 'user',
        parts: userContentToGeminiParts(m.content),
      };
    })
    .filter((entry): entry is { role: 'user' | 'model'; parts: GeminiPart[] } => entry !== null);

  return {
    contents,
    systemInstruction: systemMessages.length > 0
      ? { parts: [{ text: systemMessages.join('\n\n') }] }
      : undefined,
  };
}

function extractToolCalls(parts: GeminiPart[] | undefined): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  if (!parts) return calls;

  let fallbackIndex = 0;
  for (const part of parts) {
    if (!part.functionCall?.name) continue;

    const id = part.functionCall.id ?? `call_${Date.now()}_${fallbackIndex++}`;
    // Remember the signature under the id we're about to hand out, so we can
    // re-inject it on the follow-up even if the client's round-trip drops it.
    rememberSig(id, part.thoughtSignature);
    calls.push({
      id,
      type: 'function',
      function: {
        name: part.functionCall.name,
        arguments: normalizeGeminiArgs(part.functionCall.args),
      },
      thought_signature: part.thoughtSignature,
    });
  }

  return calls;
}

function extractText(parts: GeminiPart[] | undefined): string | null {
  if (!parts) return null;
  const text = parts
    .map(p => p.text ?? '')
    .join('');
  return text.length > 0 ? text : null;
}

export class GoogleProvider extends BaseProvider {
  readonly platform = 'google' as const;
  readonly name = 'Google AI Studio';
  // Gemini's native responseMimeType is wired below. No confirmed reasoning
  // (thinking-budget) dialect yet — left unset.
  readonly dialect: DialectConfig = { jsonMode: true };

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const { contents, systemInstruction } = toGeminiContents(messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: toGeminiGenerationConfig(options),
      tools: toGeminiTools(options?.tools),
      toolConfig: toGeminiToolConfig(options?.tool_choice),
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const url = `${API_BASE}/models/${modelId}:generateContent?key=${apiKey}`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Google API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json() as GeminiResponse;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts;
    const toolCalls = extractToolCalls(parts);
    const text = extractText(parts);

    const usage: TokenUsage = {
      prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
    };

    return {
      id: this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : toGeminiFinishReason(candidate?.finishReason),
      }],
      usage,
      _routed_via: { platform: 'google', model: modelId },
    };
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { contents, systemInstruction } = toGeminiContents(messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: toGeminiGenerationConfig(options),
      tools: toGeminiTools(options?.tools),
      toolConfig: toGeminiToolConfig(options?.tool_choice),
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const url = `${API_BASE}/models/${modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Google API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    const id = this.makeId();
    let buffer = '';
    let emittedFinish = false;
    let sawToolCalls = false;

    const seenToolCallKeys = new Set<string>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const raw = trimmed.slice(6);
        if (raw === '[DONE]') {
          if (!emittedFinish) {
            emittedFinish = true;
            yield {
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: sawToolCalls ? 'tool_calls' : 'stop',
              }],
            };
          }
          return;
        }

        // Skip malformed SSE frames instead of aborting the whole stream.
        // Matches the defensive parse in openai-compat / cohere / cloudflare:
        // a single corrupt chunk shouldn't take down the rest of the response.
        let chunk: GeminiResponse;
        try {
          chunk = JSON.parse(raw) as GeminiResponse;
        } catch {
          continue;
        }
        const candidate = chunk.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        const text = extractText(parts);
        const toolCalls = extractToolCalls(parts).filter(call => {
          const key = `${call.id}:${call.function.name}:${call.function.arguments}`;
          if (seenToolCallKeys.has(key)) return false;
          seenToolCallKeys.add(key);
          return true;
        });

        if ((text && text.length > 0) || toolCalls.length > 0) {
          sawToolCalls = sawToolCalls || toolCalls.length > 0;
          yield {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
              index: 0,
              delta: {
                ...(text ? { content: text } : {}),
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              },
              finish_reason: null,
            }],
          };
        }

        if (candidate?.finishReason && !emittedFinish) {
          emittedFinish = true;
          yield {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: sawToolCalls ? 'tool_calls' : toGeminiFinishReason(candidate.finishReason),
            }],
          };
          return;
        }
      }
    }

    if (!emittedFinish) {
      yield {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: sawToolCalls ? 'tool_calls' : 'stop',
        }],
      };
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable. Only confirmed 401/403 disables a key.
    const res = await this.fetchWithTimeout(
      `${API_BASE}/models?key=${apiKey}`,
      { method: 'GET' },
      10000,
    );
    return res.status !== 401 && res.status !== 403;
  }
}
