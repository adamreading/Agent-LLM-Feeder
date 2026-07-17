import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Low caps + fast cooldowns set BEFORE importing searchPool (module reads env at
// load). cost/call = $0.005, so: job cap 0.005 = 1 You.com call/job; global cap
// 0.015 = 3 You.com calls total.
process.env.FEEDER_YOU_JOB_CAP_USD = '0.005';
process.env.FEEDER_YOU_SPEND_CAP_USD = '0.015';
process.env.ENCRYPTION_KEY = '0'.repeat(64);

// Controllable fake engines. behavior[id] ∈ 'ok'|'empty'|'throttle'|'error'.
const h = vi.hoisted(() => ({ behavior: {} as Record<string, string> }));
vi.mock('../../services/webSearch.js', async () => {
  const actual = await vi.importActual<any>('../../services/webSearch.js');
  const make = (id: string) => ({
    id, isConfigured: () => true,
    search: async () => {
      const b = h.behavior[id] ?? 'ok';
      if (b === 'throttle') throw new Error('429 rate limit exceeded');
      if (b === 'error') throw new Error('ECONNRESET');
      if (b === 'empty') return [];
      return [{ title: id, url: `https://${id}.test`, content: 'c' }];
    },
    fetch: async () => ({ title: '', content: '' }),
  });
  return { ...actual, getBackendById: (id: string) => make(id) };
});

const { initDb, closeDb, getPool } = await import('../../db/index.js');
const { run } = await import('../../db/pgCompat.js');
const { createTestDb } = await import('../testDb.js');
const { setSearchPool } = await import('../../services/searchConfig.js');
const { poolSearch, getSearchHealth, _resetJobSpend } = await import('../../services/searchPool.js');

async function served(runId?: string) {
  const r = await poolSearch('q', 6, { runId });
  return { backend: r.backend, reason: r.reason, n: r.results.length };
}

describe('searchPool — spread / cooldown / last-resort / caps', () => {
  let drop: () => Promise<void>;
  beforeAll(async () => { const t = await createTestDb(); drop = t.drop; await initDb(t.connectionString); });
  afterAll(async () => { await closeDb(); await drop(); });
  beforeEach(async () => {
    await run(getPool(), `TRUNCATE search_backend_health`);
    await run(getPool(), `DELETE FROM settings WHERE key IN ('web_search_pool','web_search_backend')`);
    _resetJobSpend();
    h.behavior = {};
  });

  it('spreads evenly across healthy free engines (LRU) — no single engine hammered', async () => {
    await setSearchPool(getPool(), ['tavily', 'brave', 'serper']);
    const a = await served(), b = await served(), c = await served();
    // Three calls → three DIFFERENT free engines (even spread).
    expect(new Set([a.backend, b.backend, c.backend])).toEqual(new Set(['tavily', 'brave', 'serper']));
  });

  it('throttled engine goes on cooldown and load shifts to the rest', async () => {
    await setSearchPool(getPool(), ['tavily', 'brave']);
    h.behavior = { tavily: 'throttle', brave: 'ok' };
    const first = await served();
    expect(first.backend).toBe('brave');       // tavily throttled → shifted to brave
    // tavily is now cooling down; next call skips it entirely (still brave).
    const second = await served();
    expect(second.backend).toBe('brave');
    const health = new Map((await getSearchHealth()).map(x => [x.backend, x]));
    expect(health.get('tavily')?.cooldown_until).toBeTruthy();
    expect(health.get('tavily')?.fail_count).toBeGreaterThan(0);
  });

  it('reason=throttled when the WHOLE free tier throttles (feeds X-Augment-Skipped)', async () => {
    await setSearchPool(getPool(), ['tavily', 'brave']);
    h.behavior = { tavily: 'throttle', brave: 'throttle' };
    const r = await served();
    expect(r.n).toBe(0);
    expect(r.reason).toBe('throttled');
  });

  it('You.com fires ONLY when the free tier is exhausted (last line of defence)', async () => {
    await setSearchPool(getPool(), ['tavily', 'you']);
    h.behavior = { tavily: 'ok', you: 'ok' };
    expect((await served()).backend).toBe('tavily'); // free works → You.com untouched
    let health = new Map((await getSearchHealth()).map(x => [x.backend, x]));
    expect(health.get('you')?.calls_total ?? 0).toBe(0);
    // Now the free engine throttles → You.com becomes the fallback.
    h.behavior = { tavily: 'throttle', you: 'ok' };
    expect((await served('jobA')).backend).toBe('you');
  });

  it('per-job $5 cap: You.com blocked after the job hits its cutoff', async () => {
    await setSearchPool(getPool(), ['tavily', 'you']);
    h.behavior = { tavily: 'throttle', you: 'ok' };
    expect((await served('job1')).backend).toBe('you');   // 1st you call for job1 (= $0.005, at cap)
    const second = await served('job1');                  // job1 now at cap → you skipped
    expect(second.backend).toBeNull();
    expect(second.reason).toBe('throttled');
  });

  it('global cap: You.com blocked after total spend ceiling regardless of job', async () => {
    await setSearchPool(getPool(), ['tavily', 'you']);
    h.behavior = { tavily: 'throttle', you: 'ok' };
    // Distinct runIds so the per-job cap never trips — only the global (3-call) cap.
    expect((await served('r1')).backend).toBe('you');
    expect((await served('r2')).backend).toBe('you');
    expect((await served('r3')).backend).toBe('you');
    const capped = await served('r4');                    // global 3-call cap reached
    expect(capped.backend).toBeNull();
  });

  it('skips a quota-EXHAUSTED free engine, uses one with headroom', async () => {
    await setSearchPool(getPool(), ['serpapi', 'tinyfish']); // serpapi cap=100/mo; tinyfish uncapped
    await run(getPool(), `INSERT INTO search_backend_health (backend, period_calls, period_start, calls_total) VALUES ('serpapi', 100, now(), 100)`);
    const r = await served();
    expect(r.backend).toBe('tinyfish'); // serpapi remaining 0 → skipped
  });

  it('deprioritizes a near-exhausted engine (low headroom) below a healthy one', async () => {
    await setSearchPool(getPool(), ['serpapi', 'tinyfish']);
    await run(getPool(), `INSERT INTO search_backend_health (backend, period_calls, period_start, calls_total) VALUES ('serpapi', 90, now(), 90)`); // 10/100 = 10% < 15% → low band
    const r = await served();
    expect(r.backend).toBe('tinyfish'); // high-headroom carries load; serpapi's last credits spared
  });

  it('records per-engine telemetry (latency + success)', async () => {
    await setSearchPool(getPool(), ['tavily']);
    await served();
    const t = (await getSearchHealth()).find(x => x.backend === 'tavily');
    expect(t?.success_count).toBe(1);
    expect(t?.calls_total).toBe(1);
    expect(t?.lastUsedAt ?? t?.last_used_at).toBeTruthy(); // recorded (latency may be 0 for an instant mock)
  });
});
