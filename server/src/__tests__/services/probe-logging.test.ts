import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run, get } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { probeTools, probeJsonMode } from '../../services/probes/methods.js';
import type { ProbeContext } from '../../services/probes/runner.js';

// Found live 2026-07-08 (Adam noticed the UI's monthly-token-budget
// dashboard stayed at 100% remaining despite a full night of real probe
// traffic): probes call providers directly, bypassing routes/proxy.ts's
// request logging entirely, so real token consumption from probing was
// invisible to feeder's own accounting. This proves the fix: every probe
// call now lands a row in `requests` (tagged is_probe=true) same as it
// would consuming real quota via the actual proxy endpoint.
describe('Probe calls log real token usage into requests (is_probe=true)', () => {
  let drop: () => Promise<void>;
  let provider: OpenAICompatProvider;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const testDb = await createTestDb();
    drop = testDb.drop;
    await initDb(testDb.connectionString);
    provider = new OpenAICompatProvider({ platform: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' });
  });

  afterAll(async () => {
    await closeDb();
    await drop();
  });

  beforeEach(async () => {
    await run(getPool(), 'DELETE FROM requests');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a requests row with is_probe=true and real token counts on a successful probe', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'chatcmpl-probe-log-test',
        object: 'chat.completion',
        created: 123,
        model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
      }),
    } as any);

    const ctx: ProbeContext = { provider, apiKey: 'test-key', modelId: 'llama-3.3-70b-versatile', modelDbId: 1, platform: 'groq' };
    await probeTools(ctx);

    // logProbeRequest is fire-and-forget (void), give it a tick to land.
    await new Promise((r) => setTimeout(r, 50));

    const row = await get<{ platform: string; model_id: string; input_tokens: number; output_tokens: number; is_probe: boolean; status: string }>(getPool(), `
      SELECT platform, model_id, input_tokens, output_tokens, is_probe, status FROM requests ORDER BY id DESC LIMIT 1
    `);
    expect(row).toMatchObject({
      platform: 'groq',
      model_id: 'llama-3.3-70b-versatile',
      input_tokens: 42,
      output_tokens: 7,
      is_probe: true,
      status: 'success',
    });
  });

  it('records a requests row with is_probe=true and zero tokens on a failed probe', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Groq API error 429: Too Many Requests'));

    const ctx: ProbeContext = { provider, apiKey: 'test-key', modelId: 'llama-3.3-70b-versatile', modelDbId: 1, platform: 'groq' };
    await probeJsonMode(ctx);
    await new Promise((r) => setTimeout(r, 50));

    const row = await get<{ is_probe: boolean; status: string; error: string }>(getPool(), `
      SELECT is_probe, status, error FROM requests ORDER BY id DESC LIMIT 1
    `);
    expect(row?.is_probe).toBe(true);
    expect(row?.status).toBe('error');
    expect(row?.error).toContain('429');
  });
});
