import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { observeCapabilities } from '../../services/capabilityObserve.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run, get } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';
import type { ChatCompletionResponse } from '@freellmapi/shared/types.js';

// Passive capability observation — collect what a model demonstrably DID on
// real traffic (source='observed'), the token-free replacement for active
// probe sweeps (Adam, 2026-07-10).
describe('capabilityObserve — live capability harvest from real completions', () => {
  let drop: () => Promise<void>;
  let modelId: number;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const testDb = await createTestDb();
    drop = testDb.drop;
    await initDb(testDb.connectionString);
  });

  afterAll(async () => {
    await closeDb();
    await drop();
  });

  beforeEach(async () => {
    await run(getPool(), `DELETE FROM models WHERE model_id = 'observe-model'`);
    const row = await get<{ id: number }>(getPool(), `
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank)
      VALUES ('groq', 'observe-model', 'Observe Model', 40, 40) RETURNING id
    `);
    modelId = row!.id;
  });

  function response(message: any): ChatCompletionResponse {
    return {
      id: 'chatcmpl-x', object: 'chat.completion', created: 0, model: 'observe-model',
      choices: [{ index: 0, message, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } as ChatCompletionResponse;
  }

  async function observedRow(capability: string) {
    return get<any>(getPool(),
      `SELECT * FROM model_capabilities WHERE model_db_id = ? AND capability = ? AND source = 'observed'`,
      [modelId, capability]);
  }

  it('records observed tools=true when the model actually returns tool_calls', async () => {
    await observeCapabilities(modelId, { hadTools: true, hadResponseFormat: false },
      response({ role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] }));
    const row = await observedRow('tools');
    expect(row).toBeTruthy();
    expect(row.supported).toBe(true);
  });

  it('does NOT record tools when the model answered directly (no tool_calls) — absence is not disproof', async () => {
    await observeCapabilities(modelId, { hadTools: true, hadResponseFormat: false },
      response({ role: 'assistant', content: 'Here is the answer.' }));
    expect(await observedRow('tools')).toBeFalsy();
  });

  it('records observed json_mode=true when response_format was asked and clean JSON came back', async () => {
    await observeCapabilities(modelId, { hadTools: false, hadResponseFormat: true },
      response({ role: 'assistant', content: '{"answer": 42}' }));
    const row = await observedRow('json_mode');
    expect(row).toBeTruthy();
    expect(row.supported).toBe(true);
  });

  it('does NOT record json_mode when the model returned prose despite response_format (the ob-claude scar)', async () => {
    await observeCapabilities(modelId, { hadTools: false, hadResponseFormat: true },
      response({ role: 'assistant', content: 'Sure! The answer is 42.' }));
    expect(await observedRow('json_mode')).toBeFalsy();
  });

  it('does not record tools when the request never offered tools', async () => {
    await observeCapabilities(modelId, { hadTools: false, hadResponseFormat: false },
      response({ role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }] }));
    expect(await observedRow('tools')).toBeFalsy();
  });

  it('upserts — a second observation refreshes the same row, not a duplicate', async () => {
    const resp = response({ role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'a', arguments: '{}' } }] });
    await observeCapabilities(modelId, { hadTools: true, hadResponseFormat: false }, resp);
    await observeCapabilities(modelId, { hadTools: true, hadResponseFormat: false }, resp);
    const rows = await get<any>(getPool(),
      `SELECT count(*)::int AS n FROM model_capabilities WHERE model_db_id = ? AND capability = 'tools' AND source = 'observed'`,
      [modelId]);
    expect(rows.n).toBe(1);
  });
});
