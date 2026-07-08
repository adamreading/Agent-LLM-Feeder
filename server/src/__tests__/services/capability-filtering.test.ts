import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { routeRequest, RoutingError } from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run, get } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';
import { encrypt } from '../../lib/crypto.js';

// Every candidate must clear canMakeRequest/canUseTokens for these tests —
// they're about capability/tier/context eligibility, not quota mechanics.
vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(() => true),
    canUseTokens: vi.fn(() => true),
    isOnCooldown: vi.fn(() => false),
  };
});

async function addKey(platform: string, label: string) {
  const { encrypted, iv, authTag } = encrypt(`test-${platform}-key`);
  await run(getPool(), `
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', true)
  `, [platform, label, encrypted, iv, authTag]);
}

async function firstModelId(platform: string): Promise<number> {
  const row = await get<{ id: number }>(getPool(), 'SELECT id FROM models WHERE platform = ? LIMIT 1', [platform]);
  return row!.id;
}

// The seeded catalog has 91 models — a platform-level key (addKey) makes
// EVERY model on that platform reachable, and other platforms may also
// independently satisfy a given need. To test a SPECIFIC candidate's
// eligibility in isolation, disable every other fallback_config entry first.
// Takes numeric model DB ids (not model_id strings) — two catalog rows on
// different platforms can share the same model_id string (e.g. an OpenRouter
// mirror of a model also offered directly), which would silently defeat
// isolation if matched by string.
async function isolateCandidates(modelDbIds: number[]) {
  const pool = getPool();
  await run(pool, 'UPDATE fallback_config SET enabled = false');
  for (const id of modelDbIds) {
    await run(pool, 'UPDATE fallback_config SET enabled = true WHERE model_db_id = ?', [id]);
  }
}

describe('P2: capability/dialect filtering, two-gate trust, context-length awareness', () => {
  let drop: () => Promise<void>;

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
    const pool = getPool();
    await run(pool, 'DELETE FROM api_keys');
    await run(pool, 'DELETE FROM model_capabilities');
    await run(pool, 'UPDATE fallback_config SET enabled = true'); // reset from any prior isolation
    vi.clearAllMocks();
    (ratelimit.canMakeRequest as any).mockReturnValue(true);
    (ratelimit.canUseTokens as any).mockReturnValue(true);
    (ratelimit.isOnCooldown as any).mockReturnValue(false);
  });

  describe('json_mode capability gate', () => {
    it('throws NO_ELIGIBLE_MODEL when the only reachable candidate has no declared json_mode dialect', async () => {
      // Kilo has no dialect declared (P2: aggregator, unconfirmed pending P3 probes).
      await isolateCandidates([await firstModelId('kilo')]);
      await addKey('kilo', 'test');

      await expect(routeRequest({ needs: ['json_mode'] })).rejects.toMatchObject({
        code: 'NO_ELIGIBLE_MODEL',
      });
    });

    it('routes to a json_mode-capable provider when one is available', async () => {
      await isolateCandidates([await firstModelId('groq')]);
      await addKey('groq', 'test'); // groq declares jsonMode: true
      const result = await routeRequest({ needs: ['json_mode'] });
      expect(result.platform).toBe('groq');
    });

    it('skips a non-json-capable provider in favor of a json_mode-capable one, never silently sending it anyway', async () => {
      await isolateCandidates([await firstModelId('kilo'), await firstModelId('groq')]);
      await addKey('kilo', 'test');
      await addKey('groq', 'test');
      const result = await routeRequest({ needs: ['json_mode'] });
      expect(result.platform).toBe('groq');
    });

    it('with no needs declared, routing is unaffected (zero behavior change for existing callers)', async () => {
      await isolateCandidates([await firstModelId('kilo')]);
      await addKey('kilo', 'test');
      const result = await routeRequest({});
      expect(result.platform).toBe('kilo');
    });
  });

  describe('reasoning_control capability gate', () => {
    it('throws NO_ELIGIBLE_MODEL when the only reachable candidate has no known reasoning dialect', async () => {
      await isolateCandidates([await firstModelId('cerebras')]); // no reasoning dialect declared
      await addKey('cerebras', 'test');
      await expect(routeRequest({ needs: ['reasoning_control'] })).rejects.toMatchObject({
        code: 'NO_ELIGIBLE_MODEL',
      });
    });

    it('routes to a provider with a confirmed reasoning dialect (Ollama)', async () => {
      await isolateCandidates([await firstModelId('ollama')]);
      await addKey('ollama', 'test');
      const result = await routeRequest({ needs: ['reasoning_control'] });
      expect(result.platform).toBe('ollama');
    });

    it('excludes NVIDIA NIM — its reasoning dialect is NOT declared (live P2 demo proved it fails for at least one real NIM model: "chat_template is not supported for Mistral tokenizers")', async () => {
      await isolateCandidates([await firstModelId('nvidia')]);
      await addKey('nvidia', 'test');
      await expect(routeRequest({ needs: ['reasoning_control'] })).rejects.toMatchObject({
        code: 'NO_ELIGIBLE_MODEL',
      });
    });

    it('excludes Groq — its reasoning_effort dialect is NOT declared (live P2 demo proved gpt-oss rejects "none": "must be one of low, medium, or high")', async () => {
      await isolateCandidates([await firstModelId('groq')]);
      await addKey('groq', 'test');
      await expect(routeRequest({ needs: ['reasoning_control'] })).rejects.toMatchObject({
        code: 'NO_ELIGIBLE_MODEL',
      });
    });
  });

  describe('tools capability gate (per-model, DB-backed — ob-claude review, 2026-07-07)', () => {
    it('throws NO_ELIGIBLE_MODEL when no model has a confirmed tools capability row, even with a key present', async () => {
      const groqId = await firstModelId('groq');
      await isolateCandidates([groqId]);
      await addKey('groq', 'test');
      // Deliberately NOT inserting a model_capabilities row — this is the
      // exact "landed on a capable model by coincidence" gap ob-claude
      // flagged: no confirmed row must mean no eligibility, full stop.
      await expect(routeRequest({ needs: ['tools'] })).rejects.toMatchObject({
        code: 'NO_ELIGIBLE_MODEL',
      });
    });

    it('routes to a model with a confirmed tools capability row', async () => {
      const groqId = await firstModelId('groq');
      await isolateCandidates([groqId]);
      await addKey('groq', 'test');
      await run(getPool(), `INSERT INTO model_capabilities (model_db_id, capability, supported, source) VALUES (?, 'tools', true, 'measured')`, [groqId]);
      const result = await routeRequest({ needs: ['tools'] });
      expect(result.platform).toBe('groq');
    });

    it('is a PER-MODEL fact, not per-provider: confirming tools on one model does not make a sibling model on the same provider eligible', async () => {
      const pool = getPool();
      await run(pool, `
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
        VALUES ('groq', 'synthetic-no-tools-model', 'Synthetic No Tools', 0, 1, true)
      `);
      const untested = await get<{ id: number }>(pool, `SELECT id FROM models WHERE model_id = 'synthetic-no-tools-model'`);
      await run(pool, `INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 0, true)`, [untested!.id]);
      // A DIFFERENT groq model has confirmed tools — the synthetic one does not.
      const otherGroqId = await firstModelId('groq');
      await run(pool, `INSERT INTO model_capabilities (model_db_id, capability, supported, source) VALUES (?, 'tools', true, 'measured')`, [otherGroqId]);

      await isolateCandidates([untested!.id]); // ONLY the untested model is reachable
      await addKey('groq', 'test');
      await expect(routeRequest({ needs: ['tools'] })).rejects.toMatchObject({
        code: 'NO_ELIGIBLE_MODEL',
      });
    });
  });

  describe('ob_readwrite capability gate (wsl-claude pre-wire catch, 2026-07-08)', () => {
    it('throws NO_ELIGIBLE_MODEL when tools is confirmed but ob_readwrite is not — measuring a capability is not the same as gating on it', async () => {
      const groqId = await firstModelId('groq');
      await isolateCandidates([groqId]);
      await addKey('groq', 'test');
      await run(getPool(), `INSERT INTO model_capabilities (model_db_id, capability, supported, source) VALUES (?, 'tools', true, 'measured')`, [groqId]);
      // No ob_readwrite row at all — this is exactly the gap a live 10x
      // agentic_chat test surfaced: 40% of turns landed on tools-confirmed
      // models with zero measured OB access data.
      await expect(routeRequest({ needs: ['tools', 'ob_readwrite'] })).rejects.toMatchObject({
        code: 'NO_ELIGIBLE_MODEL',
      });
    });

    it('routes to a model with both tools and ob_readwrite confirmed', async () => {
      const groqId = await firstModelId('groq');
      await isolateCandidates([groqId]);
      await addKey('groq', 'test');
      await run(getPool(), `INSERT INTO model_capabilities (model_db_id, capability, supported, source) VALUES (?, 'tools', true, 'measured')`, [groqId]);
      await run(getPool(), `INSERT INTO model_capabilities (model_db_id, capability, supported, source) VALUES (?, 'ob_readwrite', true, 'measured')`, [groqId]);
      const result = await routeRequest({ needs: ['tools', 'ob_readwrite'] });
      expect(result.platform).toBe('groq');
    });
  });

  describe('two-gate INNER enforcement: cost_tier ceiling', () => {
    it('excludes a paid-tier model when the caller is capped at free tier', async () => {
      const pool = getPool();
      await run(pool, `
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, cost_tier)
        VALUES ('nvidia', 'synthetic-paid-model', 'Synthetic Paid', 0, 1, true, 'paid')
      `);
      const model = await get<{ id: number }>(pool, `SELECT id FROM models WHERE model_id = 'synthetic-paid-model'`);
      await run(pool, `INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 0, true)`, [model!.id]);
      await isolateCandidates([model!.id]);
      await addKey('nvidia', 'test');

      await expect(routeRequest({ costTierCeiling: 'free' })).rejects.toMatchObject({
        code: 'NO_ELIGIBLE_MODEL',
      });

      // Without the ceiling, the same paid model IS reachable.
      const result = await routeRequest({});
      expect(result.modelId).toBe('synthetic-paid-model');
    });
  });

  describe('context-length awareness', () => {
    it('excludes a model whose context_window is smaller than the estimated request size', async () => {
      const pool = getPool();
      await run(pool, `
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, context_window)
        VALUES ('groq', 'synthetic-tiny-ctx', 'Synthetic Tiny Ctx', 0, 1, true, 100)
      `);
      const model = await get<{ id: number }>(pool, `SELECT id FROM models WHERE model_id = 'synthetic-tiny-ctx'`);
      await run(pool, `INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 0, true)`, [model!.id]);
      await isolateCandidates([model!.id]);
      await addKey('groq', 'test');

      await expect(routeRequest({ estimatedTokens: 5000 })).rejects.toMatchObject({
        code: 'NO_ELIGIBLE_MODEL',
      });

      const result = await routeRequest({ estimatedTokens: 50 });
      expect(result.modelId).toBe('synthetic-tiny-ctx');
    });
  });

  describe('L8: exclude_providers', () => {
    it('never routes to an explicitly excluded platform, even if it would otherwise win', async () => {
      await isolateCandidates([await firstModelId('groq'), await firstModelId('cerebras')]);
      await addKey('groq', 'test');
      await addKey('cerebras', 'test');
      const result = await routeRequest({ excludeProviders: new Set(['groq']) });
      expect(result.platform).not.toBe('groq');
    });
  });
});
