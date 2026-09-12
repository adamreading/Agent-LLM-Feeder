import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions, type DialectConfig, type ImageGenOptions, type ImageResult } from './base.js';

/**
 * Cloudflare Workers AI provider.
 * API key format expected: "account_id:api_token"
 * The account_id is extracted from the key to build the URL.
 */
export class CloudflareProvider extends BaseProvider {
  readonly platform = 'cloudflare' as const;
  readonly name = 'Cloudflare Workers AI';
  // Workers AI's OpenAI-compat endpoint accepts response_format. No confirmed
  // reasoning-control dialect across its heterogeneous @cf/* model catalog.
  readonly dialect: DialectConfig = { jsonMode: true };

  private parseKey(apiKey: string): { accountId: string; token: string } {
    const sep = apiKey.indexOf(':');
    if (sep === -1) throw new Error('Cloudflare key must be in format "account_id:api_token"');
    return { accountId: apiKey.slice(0, sep), token: apiKey.slice(sep + 1) };
  }

  // Cloudflare's OpenAI-compat endpoint rejects `content: null` on assistant
  // messages that carry tool_calls, even though the OpenAI spec allows it.
  private normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(m =>
      m.content === null ? { ...m, content: '' } : m,
    );
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.normalizeMessages(messages),
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        ...(options?.response_format ? { response_format: options.response_format } : {}),
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Cloudflare API error ${res.status}: ${(err as any).error?.message ?? (err as any).errors?.[0]?.message ?? res.statusText}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    data._routed_via = { platform: 'cloudflare', model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.normalizeMessages(messages),
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        ...(options?.response_format ? { response_format: options.response_format } : {}),
        stream: true,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Cloudflare API error ${res.status}: ${(err as any).error?.message ?? (err as any).errors?.[0]?.message ?? res.statusText}`);
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
          yield JSON.parse(data) as ChatCompletionChunk;
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable. Only confirmed bad/inactive tokens disable.
    const { token } = this.parseKey(apiKey);
    const res = await this.fetchWithTimeout(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } },
      10000,
    );
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) return true; // unexpected non-2xx that isn't auth — don't disable
    const data = await res.json() as any;
    return data.success === true && data.result?.status === 'active';
  }

  // Image generation via Workers AI `/ai/run/<model>`. Cloudflare's image models
  // are heterogeneous in their RESPONSE shape: flux returns JSON
  // {result:{image:"<base64>"}}, the Stable Diffusion models stream raw PNG
  // bytes. We normalise both to b64_json. Parsed dimensions ("1024x1024") are
  // passed as width/height where the model accepts them (ignored otherwise).
  async generateImage(apiKey: string, modelId: string, options: ImageGenOptions): Promise<ImageResult> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;
    const body: Record<string, unknown> = { prompt: options.prompt };
    if (options.negativePrompt) body.negative_prompt = options.negativePrompt;
    const dim = /^(\d+)x(\d+)$/.exec(options.size ?? '');
    if (dim) { body.width = Number(dim[1]); body.height = Number(dim[2]); }

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 60000);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Cloudflare image error ${res.status}: ${text.slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    let b64: string;
    if (ct.includes('application/json')) {
      const data = await res.json() as any;
      const img = data?.result?.image ?? data?.result?.images?.[0] ?? data?.image;
      if (typeof img !== 'string' || !img) throw new Error('Cloudflare image response had no image field');
      b64 = img;
    } else {
      // Raw image bytes (image/png etc.) → base64.
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('Cloudflare image response was empty');
      b64 = buf.toString('base64');
    }
    return { images: [{ b64_json: b64 }] };
  }
}
