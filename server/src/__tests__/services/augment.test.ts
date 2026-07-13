import { describe, it, expect, vi } from 'vitest';
import { parseAugmentPolicy, needsWebSearch, shouldAugment, isAugmentBlockedConsumer, runWebAugment } from '../../services/augment.js';

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
    expect(isAugmentBlockedConsumer('fleet')).toBe(false);
    expect(isAugmentBlockedConsumer(null)).toBe(false);
    expect(isAugmentBlockedConsumer(undefined)).toBe(false);
  });
});

describe('runWebAugment — degrade-safe', () => {
  it('returns null (unaugmented) when the backend is not configured', async () => {
    vi.doMock('../../services/webSearch.js', () => ({
      getSearchBackend: () => ({ isConfigured: () => false, search: async () => [] }),
    }));
    const { runWebAugment: fn } = await import('../../services/augment.js');
    expect(await fn('latest news')).toBeNull();
    vi.doUnmock('../../services/webSearch.js');
  });

  it('formats results into a labelled grounding block when the backend returns hits', async () => {
    vi.resetModules();
    vi.doMock('../../services/webSearch.js', () => ({
      getSearchBackend: () => ({
        isConfigured: () => true,
        search: async () => [
          { title: 'Result One', url: 'https://a.test/1', content: 'first snippet' },
          { title: 'Result Two', url: 'https://b.test/2', content: 'second snippet' },
        ],
      }),
    }));
    const { runWebAugment: fn } = await import('../../services/augment.js');
    const block = await fn('latest news', { timeoutMs: 1000 });
    expect(block).toContain('Feeder web-search context');
    expect(block).toContain('https://a.test/1');
    expect(block).toContain('Result Two');
    vi.doUnmock('../../services/webSearch.js');
    vi.resetModules();
  });
});
