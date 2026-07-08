import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';

describe('OpenAICompatProvider', () => {
  let provider: OpenAICompatProvider;

  beforeEach(() => {
    provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'TestProvider',
      baseUrl: 'https://api.test.com/v1',
      extraHeaders: { 'X-Custom': 'test' },
    });
  });

  it('should set platform and name from config', () => {
    expect(provider.platform).toBe('groq');
    expect(provider.name).toBe('TestProvider');
  });

  it('should call API with correct URL and headers', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'test-id',
          object: 'chat.completion',
          created: 123,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion('my-key', [{ role: 'user', content: 'test' }], 'test-model');

    expect(capturedUrl).toBe('https://api.test.com/v1/chat/completions');
    expect(capturedHeaders['Authorization']).toBe('Bearer my-key');
    expect(capturedHeaders['X-Custom']).toBe('test');
    expect(capturedBody.messages[0].role).toBe('user');
  });

  it('should pass tool-calling params through untouched', async () => {
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'test-id',
          object: 'chat.completion',
          created: 123,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [] }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'my-key',
      [{ role: 'user', content: 'what is weather?' }],
      'test-model',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        }],
        tool_choice: 'required',
        parallel_tool_calls: true,
      },
    );

    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.tool_choice).toBe('required');
    expect(capturedBody.parallel_tool_calls).toBe(true);
  });

  it('should throw on error response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Rate Limited',
      json: () => Promise.resolve({ error: { message: 'Too many requests' } }),
    } as any);

    await expect(
      provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model')
    ).rejects.toThrow(/Too many requests/);
  });

  it('should validate key using models endpoint', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 200 } as any);
    expect(await provider.validateKey('valid')).toBe(true);
  });

  it('validateKey returns false on confirmed 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 401 } as any);
    expect(await provider.validateKey('bad')).toBe(false);
  });

  it('validateKey propagates transport errors instead of swallowing', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(provider.validateKey('any')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('folds reasoning_content into content when content is empty (Z.ai glm-4.5-flash style)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: 'the actual answer' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('the actual answer');
  });

  it('flattens array content into a string (Mistral magistral style)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('part one part two');
  });

  it('folds reasoning into content when content is empty (Ollama style — bare `reasoning` field)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning: 'ollama answer' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('ollama answer');
  });

  // Chinese-CoT-leak guard (Adam's call, 2026-07-08). exclude_reasoning is the
  // caller's opt-in that raw reasoning must never reach it — neither folded
  // into content nor returned as a field.
  it('exclude_reasoning: does NOT fold reasoning into content, and strips the reasoning fields', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: '用中文思考…(leaked chain of thought)' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm', { exclude_reasoning: true });
    const msg = result.choices[0].message as any;
    // content stays empty — the caller opted out of the only text there was,
    // rather than have the raw CoT folded in and leaked.
    expect(msg.content === '' || msg.content == null).toBe(true);
    expect(msg.reasoning_content).toBeUndefined();
    expect(msg.reasoning).toBeUndefined();
  });

  it('exclude_reasoning: preserves a real content answer while stripping the separate reasoning field', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'The answer is 42.', reasoning_content: 'internal reasoning here' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm', { exclude_reasoning: true });
    const msg = result.choices[0].message as any;
    expect(msg.content).toBe('The answer is 42.'); // real answer untouched
    expect(msg.reasoning_content).toBeUndefined(); // reasoning stripped
  });

  it('default (no exclude_reasoning): fold behavior is unchanged for every other consumer', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: 'answer-in-reasoning model' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('answer-in-reasoning model');
  });

  it('prefers reasoning_content over reasoning when both are present', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: 'preferred', reasoning: 'fallback' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('preferred');
  });

  it('does NOT fold reasoning_content when tool_calls are present', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: 'I am thinking about the tool',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
  });

  it('leaves real string content untouched', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'normal answer', reasoning_content: 'should not override' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('normal answer');
  });
});

describe('OpenAICompatProvider - platform instances', () => {
  // Mirrors the actual registrations in server/src/providers/index.ts.
  // Update both when adding/removing a platform.
  const platforms = [
    { platform: 'groq',       name: 'Groq',          baseUrl: 'https://api.groq.com/openai/v1' },
    { platform: 'cerebras',   name: 'Cerebras',      baseUrl: 'https://api.cerebras.ai/v1' },
    { platform: 'sambanova',  name: 'SambaNova',     baseUrl: 'https://api.sambanova.ai/v1' },
    { platform: 'nvidia',     name: 'NVIDIA NIM',    baseUrl: 'https://integrate.api.nvidia.com/v1' },
    { platform: 'mistral',    name: 'Mistral',       baseUrl: 'https://api.mistral.ai/v1' },
    { platform: 'openrouter', name: 'OpenRouter',    baseUrl: 'https://openrouter.ai/api/v1' },
    { platform: 'github',     name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference' },
    { platform: 'zhipu',      name: 'Zhipu AI',      baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  ] as const;

  for (const p of platforms) {
    it(`${p.name} provider should make requests to ${p.baseUrl}`, async () => {
      const provider = new OpenAICompatProvider(p as any);

      let capturedUrl = '';
      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        capturedUrl = url as string;
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'id', object: 'chat.completion', created: 1, model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        } as any;
      });

      const result = await provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model');
      expect(capturedUrl).toContain(p.baseUrl);
      expect(result._routed_via?.platform).toBe(p.platform);
    });
  }
});

// P2: dialect emission — each field is only emitted when the provider
// instance declares support, and translated into the RIGHT wire shape.
describe('OpenAICompatProvider - dialect emission', () => {
  async function captureBody(provider: OpenAICompatProvider, options: any): Promise<any> {
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'id', object: 'chat.completion', created: 1, model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      } as any;
    });
    await provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model', options);
    vi.restoreAllMocks();
    return capturedBody;
  }

  it('never emits response_format when the provider has not declared jsonMode', async () => {
    const provider = new OpenAICompatProvider({ platform: 'kilo', name: 'Kilo', baseUrl: 'https://x.test/v1' });
    const body = await captureBody(provider, { response_format: { type: 'json_object' } });
    expect(body.response_format).toBeUndefined();
  });

  it('emits response_format as-is when jsonMode is declared', async () => {
    const provider = new OpenAICompatProvider({ platform: 'groq', name: 'Groq', baseUrl: 'https://x.test/v1', dialect: { jsonMode: true } });
    const body = await captureBody(provider, { response_format: { type: 'json_object' } });
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('translates reasoning_effort to the flat openai_reasoning_effort dialect', async () => {
    const provider = new OpenAICompatProvider({ platform: 'groq', name: 'Groq', baseUrl: 'https://x.test/v1', dialect: { reasoning: 'openai_reasoning_effort' } });
    const body = await captureBody(provider, { reasoning_effort: 'low' });
    expect(body.reasoning_effort).toBe('low');
    expect(body.reasoning).toBeUndefined();
    expect(body.chat_template_kwargs).toBeUndefined();
  });

  it('translates reasoning_effort to the nested Ollama dialect', async () => {
    const provider = new OpenAICompatProvider({ platform: 'ollama', name: 'Ollama', baseUrl: 'https://x.test/v1', dialect: { reasoning: 'nested_reasoning_effort' } });
    const body = await captureBody(provider, { reasoning_effort: 'none' });
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('translates reasoning_effort to the NIM chat_template_kwargs dialect', async () => {
    const provider = new OpenAICompatProvider({ platform: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://x.test/v1', dialect: { reasoning: 'chat_template_enable_thinking' } });
    const body = await captureBody(provider, { reasoning_effort: 'none' });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('never emits a reasoning field when no dialect is declared (capability filtering is the real gate)', async () => {
    const provider = new OpenAICompatProvider({ platform: 'cerebras', name: 'Cerebras', baseUrl: 'https://x.test/v1' });
    const body = await captureBody(provider, { reasoning_effort: 'none' });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.chat_template_kwargs).toBeUndefined();
  });

  it('threads context_length into options.num_ctx for the ollama_num_ctx dialect (ob-claude review: Ollama silently truncates at 2048 otherwise)', async () => {
    const provider = new OpenAICompatProvider({ platform: 'ollama', name: 'Ollama', baseUrl: 'https://x.test/v1', dialect: { contextLength: 'ollama_num_ctx' } });
    const body = await captureBody(provider, { context_length: 65536 });
    expect(body.options).toEqual({ num_ctx: 65536 });
  });

  it('never emits options.num_ctx when no contextLength dialect is declared', async () => {
    const provider = new OpenAICompatProvider({ platform: 'groq', name: 'Groq', baseUrl: 'https://x.test/v1' });
    const body = await captureBody(provider, { context_length: 65536 });
    expect(body.options).toBeUndefined();
  });
});

// P3: quota header capture
describe('OpenAICompatProvider - rate limit header capture', () => {
  it('captures known x-ratelimit-* headers onto the response for the harvester', async () => {
    const provider = new OpenAICompatProvider({ platform: 'groq', name: 'Groq', baseUrl: 'https://x.test/v1' });
    vi.spyOn(global, 'fetch').mockImplementation(async () => ({
      ok: true,
      headers: new Headers({
        'x-ratelimit-remaining-tokens': '5990',
        'x-ratelimit-limit-tokens': '6000',
        'x-unrelated-header': 'ignored',
      }),
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    } as any));

    const result = await provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model');
    expect(result._rate_limit_headers).toEqual({
      'x-ratelimit-remaining-tokens': '5990',
      'x-ratelimit-limit-tokens': '6000',
    });
  });

  it('leaves _rate_limit_headers undefined when the provider sends none', async () => {
    const provider = new OpenAICompatProvider({ platform: 'kilo', name: 'Kilo', baseUrl: 'https://x.test/v1' });
    vi.spyOn(global, 'fetch').mockImplementation(async () => ({
      ok: true,
      headers: new Headers(),
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    } as any));

    const result = await provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model');
    expect(result._rate_limit_headers).toBeUndefined();
  });
});
