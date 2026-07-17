import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { all, get, run, runReturningId } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';

// Mutable mock state (hoisted so the vi.mock factories can close over it).
const h = vi.hoisted(() => ({
  discovery: {} as Record<string, { status: number; ids: string[]; err?: string }>,
  researchOpts: null as any,
  enableOpts: null as any,
}));

// Discovery is the only network dependency of the reconciler — mock it to a
// controlled live-list. Keep isTrustworthyPoll REAL (the retirement gate depends
// on it) by spreading the actual module.
vi.mock('../../services/catalogDiscovery.js', async () => {
  const actual = await vi.importActual<any>('../../services/catalogDiscovery.js');
  return { ...actual, discoverLiveModels: async () => h.discovery };
});
// The two token-touching stages are no-ops here (their own units cover them);
// we just capture the caps they were called with to prove they're wired.
vi.mock('../../services/livenessEnable.js', async () => {
  const actual = await vi.importActual<any>('../../services/livenessEnable.js');
  return { ...actual, livenessEnablePending: async (_p: any, opts: any) => { h.enableOpts = opts; return { checked: 0, enabled: [], paid: 0, dead: 0, transient: 0, nokey: 0 }; } };
});
vi.mock('../../services/modelResearch.js', async () => {
  const actual = await vi.importActual<any>('../../services/modelResearch.js');
  return { ...actual, researchMissingCanonicals: async (_p: any, opts: any) => { h.researchOpts = opts; return { researched: [], skipped: 'no_missing' }; } };
});

const { runCatalogSync } = await import('../../services/catalogSync.js');

interface SeedModel {
  platform: string; modelId: string; enabled?: boolean; disabledReason?: string | null;
  lastSeenLive?: 'now' | 'old' | null; missingPolls?: number; kind?: string;
}
async function seed(m: SeedModel): Promise<number> {
  const seen = m.lastSeenLive === 'now' ? 'now()' : m.lastSeenLive === 'old' ? "now() - interval '10 days'" : 'NULL';
  return runReturningId(getPool(), `
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, disabled_reason, kind, match_status, last_seen_live, missing_polls)
    VALUES (?, ?, ?, 500, 500, ?, ?, ?, 'unmatched', ${seen}, ?)
  `, [m.platform, m.modelId, m.modelId, m.enabled ?? true, m.disabledReason ?? null, m.kind ?? 'chat', m.missingPolls ?? 0]);
}
async function rowOf(id: number) {
  return get<{ enabled: boolean; disabled_reason: string | null; missing_polls: number; last_seen_live: string | null }>(
    getPool(), `SELECT enabled, disabled_reason, missing_polls, last_seen_live FROM models WHERE id = ?`, [id]);
}

describe('runCatalogSync — reconciliation (add / retire / reappear / safety)', () => {
  let drop: () => Promise<void>;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const testDb = await createTestDb();
    drop = testDb.drop;
    await initDb(testDb.connectionString);
  });
  afterAll(async () => { await closeDb(); await drop(); });

  beforeEach(async () => {
    // Clean slate each test — the seed catalog + its dependents.
    await run(getPool(), `TRUNCATE models, canonical_models, canonical_model_aliases, model_health, model_capabilities, task_scores RESTART IDENTITY CASCADE`);
    h.discovery = {}; h.researchOpts = null; h.enableOpts = null;
  });

  it('adds ids present upstream but missing from the catalog (disabled, pending-liveness)', async () => {
    const a = await seed({ platform: 'groq', modelId: 'a', lastSeenLive: 'now' });
    h.discovery = { groq: { status: 200, ids: ['a', 'b'] } };

    const s = await runCatalogSync(getPool(), { retireThreshold: 3 });

    expect(s.added).toBe(1);
    const b = await get<{ id: number }>(getPool(), `SELECT id FROM models WHERE platform='groq' AND model_id='b'`);
    const bRow = await rowOf(b!.id);
    expect(bRow!.enabled).toBe(false);
    expect(bRow!.disabled_reason).toMatch(/^pending-liveness/);
    expect(bRow!.last_seen_live).not.toBeNull();
    // present id 'a' keeps its miss counter at 0
    expect((await rowOf(a))!.missing_polls).toBe(0);
  });

  it('does NOT retire before the threshold, then soft-retires exactly at it', async () => {
    const a = await seed({ platform: 'groq', modelId: 'a', enabled: true, lastSeenLive: 'now', missingPolls: 0 });
    h.discovery = { groq: { status: 200, ids: ['x'] } }; // 'a' absent every run

    await runCatalogSync(getPool(), { retireThreshold: 2 });
    let r = await rowOf(a);
    expect(r!.missing_polls).toBe(1);
    expect(r!.enabled).toBe(true); // 1 < 2 → still live

    const s2 = await runCatalogSync(getPool(), { retireThreshold: 2 });
    r = await rowOf(a);
    expect(r!.enabled).toBe(false);
    expect(r!.disabled_reason).toBe('delisted');
    expect(s2.retired).toBe(1);
  });

  it('NEVER retires on a failed or empty poll (a provider blip must not delist)', async () => {
    const a = await seed({ platform: 'groq', modelId: 'a', enabled: true, lastSeenLive: 'now', missingPolls: 0 });
    // 500 error AND (separately) a 200-but-empty both count as untrustworthy.
    for (const bad of [{ status: 500, ids: [] as string[] }, { status: 200, ids: [] as string[] }]) {
      h.discovery = { groq: bad };
      const s = await runCatalogSync(getPool(), { retireThreshold: 1 });
      const r = await rowOf(a);
      expect(r!.enabled).toBe(true);
      expect(r!.missing_polls).toBe(0);
      expect(s.retired).toBe(0);
      expect(s.platforms.groq.trustworthy).toBe(false);
    }
  });

  it('un-retires a delisted model that reappears upstream', async () => {
    const a = await seed({ platform: 'groq', modelId: 'a', enabled: false, disabledReason: 'delisted', lastSeenLive: 'old', missingPolls: 5 });
    h.discovery = { groq: { status: 200, ids: ['a'] } };

    const s = await runCatalogSync(getPool(), { retireThreshold: 3 });

    expect(s.reappeared).toBe(1);
    const r = await rowOf(a);
    expect(r!.disabled_reason).toMatch(/^pending-liveness/);
    expect(r!.missing_polls).toBe(0);
    expect(r!.last_seen_live).not.toBeNull();
  });

  it('respects reason ownership + never-seen-live rows (no over-reach)', async () => {
    const manual = await seed({ platform: 'groq', modelId: 'manual-off', enabled: false, disabledReason: 'manual', lastSeenLive: 'now' });
    const neverSeen = await seed({ platform: 'groq', modelId: 'seed-only', enabled: true, lastSeenLive: null });
    h.discovery = { groq: { status: 200, ids: ['something-else'] } }; // neither present

    const s = await runCatalogSync(getPool(), { retireThreshold: 1 });

    expect(s.retired).toBe(0);
    expect((await rowOf(manual))!.disabled_reason).toBe('manual');   // not overridden to 'delisted'
    const ns = await rowOf(neverSeen);
    expect(ns!.enabled).toBe(true);        // never-seen-live rows are untouched
    expect(ns!.missing_polls).toBe(0);
  });

  it('passes the per-run caps through to the token-touching stages', async () => {
    h.discovery = { groq: { status: 200, ids: ['a'] } };
    await seed({ platform: 'groq', modelId: 'a', lastSeenLive: 'now' });

    await runCatalogSync(getPool(), { researchLimit: 10, enableLimit: 15 });

    expect(h.enableOpts?.limit).toBe(15);
    expect(h.researchOpts?.limit).toBe(10);
  });
});
