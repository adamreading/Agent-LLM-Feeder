import { describe, it, expect, vi, beforeEach } from 'vitest';

// runWebAugment now runs search via the POOL (searchPool.poolSearch); mock it so
// these stay pure unit tests (pool selection/caps have their own tests). Hoisted
// state lets each test drive the pool's return + count calls (for cache dedup).
const h = vi.hoisted(() => ({ result: { results: [] as any[], reason: null as any, backend: null as any }, calls: 0 }));
vi.mock('../../services/searchPool.js', async () => {
  const actual = await vi.importActual<any>('../../services/searchPool.js');
  return { ...actual, poolSearch: async () => { h.calls++; return h.result; } };
});

const { parseAugmentPolicy, needsWebSearch, shouldAugment, isAugmentBlockedConsumer, runWebAugment } = await import('../../services/augment.js');
const { _resetSearchCache } = await import('../../services/searchCache.js');

const hit = (url: string) => [{ title: url, url, content: 'snippet' }];

describe('parseAugmentPolicy', () => {
  it('accepts auto/force, everything else → off (the safe default)', () => {
    expect(parseAugmentPolicy('auto')).toBe('auto');
    expect(parseAugmentPolicy('force')).toBe('force');
    expect(parseAugmentPolicy('off')).toBe('off');
    expect(parseAugmentPolicy(undefined)).toBe('off');
    expect(parseAugmentPolicy('yes')).toBe('off');
    expect(parseAugmentPolicy(true)).toBe('off');
  });
});

describe('needsWebSearch', () => {
  it('fires on current/recency + explicit-lookup signals', () => {
    expect(needsWebSearch('what is the latest news on the election')).toBe(true);
    expect(needsWebSearch('who won the game today')).toBe(true);
    expect(needsWebSearch('search the web for the current bitcoin price')).toBe(true);
    expect(needsWebSearch('what happened in 2027')).toBe(true);
  });
  it('stays quiet on evergreen questions (no false search)', () => {
    expect(needsWebSearch('explain how a hash map works')).toBe(false);
    expect(needsWebSearch('write a poem about the sea')).toBe(false);
    expect(needsWebSearch('what is the capital of France')).toBe(false);
    expect(needsWebSearch('')).toBe(false);
  });
});

describe('shouldAugment — the carve-out gate', () => {
  it('off NEVER augments, whatever the prompt', () => {
    expect(shouldAugment('off', 'what is the latest news today')).toBe(false);
    expect(shouldAugment('off', 'search the web for x')).toBe(false);
  });
  it('auto augments only when the prompt needs current info', () => {
    expect(shouldAugment('auto', 'latest news today')).toBe(true);
    expect(shouldAugment('auto', 'explain recursion')).toBe(false);
  });
  it('force always augments', () => {
    expect(shouldAugment('force', 'explain recursion')).toBe(true);
  });
});

describe('isAugmentBlockedConsumer — OB P4b hard block', () => {
  it('blocks open-brain (case-insensitive), allows others', () => {
    expect(isAugmentBlockedConsumer('open-brain')).toBe(true);
    expect(isAugmentBlockedConsumer('Open-Brain')).toBe(true);
    expect(isAugmentBlockedConsumer('hermes')).toBe(false);
    expect(isAugmentBlockedConsumer(null)).toBe(false);
  });
});

describe('runWebAugment — maps pool result → grounding block / skip reason', () => {
  beforeEach(() => { _resetSearchCache(); h.calls = 0; });

  it('formats results into a labelled grounding block (skipped=null) on hits', async () => {
    h.result = { results: hit('https://a.test/1'), reason: null, backend: 'tavily' };
    const r = await runWebAugment('some fresh query');
    expect(r.skipped).toBeNull();
    expect(r.context).toContain('Feeder web-search context');
    expect(r.context).toContain('https://a.test/1');
  });

  it('passes the pool skip-reason straight through when nothing was injected', async () => {
    for (const reason of ['throttled', 'no-results', 'no-config', 'error'] as const) {
      _resetSearchCache();
      h.result = { results: [], reason, backend: null };
      const r = await runWebAugment(`q-${reason}`);
      expect(r.context).toBeNull();
      expect(r.skipped).toBe(reason);
    }
  });

  it('shared cache dedups an identical query — 2nd call served from cache, no 2nd pool search', async () => {
    h.result = { results: hit('https://x.test'), reason: null, backend: 'brave' };
    const a = await runWebAugment('same cached question');
    const b = await runWebAugment('SAME cached question  '); // normalized-equal
    expect(a.context).toContain('https://x.test');
    expect(b.context).toContain('https://x.test');
    expect(h.calls).toBe(1); // 2nd hit the cache
  });
});
