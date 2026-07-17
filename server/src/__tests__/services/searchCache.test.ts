import { describe, it, expect, beforeEach } from 'vitest';
import { getCachedSearch, setCachedSearch, _resetSearchCache } from '../../services/searchCache.js';

const R = (u: string) => [{ title: u, url: u, content: 'c' }];

describe('searchCache', () => {
  beforeEach(() => _resetSearchCache());

  it('hits on the same query and normalizes case/whitespace', () => {
    setCachedSearch('The Latest News', R('a'));
    expect(getCachedSearch('the   latest news')).toEqual(R('a')); // case + ws normalized
    expect(getCachedSearch('different query')).toBeNull();        // miss
  });

  it('never caches an empty result set (so an empty stays a miss / re-searches)', () => {
    setCachedSearch('q', []);
    expect(getCachedSearch('q')).toBeNull();
    // a non-empty set for the same key DOES cache
    setCachedSearch('q', R('b'));
    expect(getCachedSearch('q')).toEqual(R('b'));
  });
});
