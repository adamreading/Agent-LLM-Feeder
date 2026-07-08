import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { get, all, run } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';
import { normalizeModelId, matchModels, linkToExistingCanonical, createCanonicalFromModel } from '../../services/modelCanon.js';

describe('normalizeModelId', () => {
  it('collapses real cross-platform spellings of the same model to the same key', () => {
    const variants = [
      'gpt-oss-120b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-120b:free',
      '@cf/openai/gpt-oss-120b',
    ];
    const keys = new Set(variants.map(normalizeModelId));
    expect(keys.size).toBe(1);
  });

  it('does not collapse genuinely different models', () => {
    expect(normalizeModelId('gpt-oss-120b')).not.toBe(normalizeModelId('gpt-oss-20b'));
    expect(normalizeModelId('llama-3.3-70b-versatile')).not.toBe(normalizeModelId('llama-4-scout-17b-16e-instruct'));
  });

  it('strips -latest/-preview suffixes and org-path prefixes consistently', () => {
    expect(normalizeModelId('codestral-latest')).toBe(normalizeModelId('mistralai/codestral-latest'));
    expect(normalizeModelId('gemini-3.1-flash-lite-preview')).toBe(normalizeModelId('google/gemini-3.1-flash-lite-preview'));
  });
});

// initDb already runs matchModels() once at startup (db/index.ts) — these
// tests exercise the real post-startup state plus the manual-resolution
// paths a review UI would call.
describe('matchModels — real catalog integration', () => {
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

  it('auto-merges the known real collision (gpt-oss-120b across cerebras/sambanova) into one canonical model', async () => {
    const pool = getPool();
    const rows = await all<{ id: number; platform: string; canonical_model_id: number | null; match_status: string }>(pool, `
      SELECT id, platform, canonical_model_id, match_status FROM models WHERE model_id = 'gpt-oss-120b' AND platform IN ('cerebras', 'sambanova')
    `);
    expect(rows.length).toBe(2);
    expect(rows[0].canonical_model_id).not.toBeNull();
    expect(rows[0].canonical_model_id).toBe(rows[1].canonical_model_id);
    expect(rows.every((r) => r.match_status === 'auto_matched')).toBe(true);
  });

  it('canonicalizes a genuine singleton into its own 1:1 canonical (so it appears in the wiki)', async () => {
    const pool = getPool();
    // gemini-2.5-pro has no cross-platform duplicate — it still gets its own
    // canonical entry so the whole catalog surfaces, not just duplicates.
    const row = await get<{ canonical_model_id: number | null; match_status: string }>(pool, `
      SELECT canonical_model_id, match_status FROM models WHERE model_id = 'gemini-2.5-pro' AND platform = 'google'
    `);
    expect(row).toBeDefined();
    expect(row!.canonical_model_id).not.toBeNull()
    expect(row!.match_status).toBe('auto_matched');
  });

  it('is idempotent — a second run does not create duplicate canonical entries', async () => {
    const pool = getPool();
    const before = await get<{ c: string }>(pool, 'SELECT COUNT(*) as c FROM canonical_models');
    const result = await matchModels(pool);
    const after = await get<{ c: string }>(pool, 'SELECT COUNT(*) as c FROM canonical_models');
    expect(after!.c).toBe(before!.c);
    expect(result.autoMergedGroups).toBe(0);
    expect(result.autoLinkedToExisting).toBe(0);
  });

  it('linkToExistingCanonical links an unmatched row and teaches the alias table for future auto-matching', async () => {
    const pool = getPool();
    const gptOss = await get<{ canonical_model_id: number }>(pool, `SELECT canonical_model_id FROM models WHERE model_id = 'gpt-oss-120b' AND platform = 'cerebras'`);
    const singleton = await get<{ id: number }>(pool, `SELECT id FROM models WHERE model_id = 'gemini-2.5-pro' AND platform = 'google'`);

    await linkToExistingCanonical(pool, singleton!.id, gptOss!.canonical_model_id);

    const after = await get<{ canonical_model_id: number; match_status: string }>(pool, `SELECT canonical_model_id, match_status FROM models WHERE id = ?`, [singleton!.id]);
    expect(after!.canonical_model_id).toBe(gptOss!.canonical_model_id);
    expect(after!.match_status).toBe('manual_matched');

    const alias = await get(pool, `SELECT id FROM canonical_model_aliases WHERE alias_key = ?`, ['gemini25pro']);
    expect(alias).toBeDefined();
  });

  it('createCanonicalFromModel creates a fresh canonical entry from an unmatched row', async () => {
    const pool = getPool();
    const row = await get<{ id: number }>(pool, `SELECT id FROM models WHERE model_id = 'magistral-medium-latest' AND platform = 'mistral'`);
    const canonicalId = await createCanonicalFromModel(pool, row!.id, { summary: 'A strong reasoning model.', vision: false });

    const canonical = await get<{ name: string; summary: string }>(pool, `SELECT name, summary FROM canonical_models WHERE id = ?`, [canonicalId]);
    expect(canonical!.summary).toBe('A strong reasoning model.');

    const linked = await get<{ canonical_model_id: number; match_status: string }>(pool, `SELECT canonical_model_id, match_status FROM models WHERE id = ?`, [row!.id]);
    expect(linked!.canonical_model_id).toBe(canonicalId);
    expect(linked!.match_status).toBe('confirmed_new');
  });
});
