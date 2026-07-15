import { describe, it, expect } from 'vitest';
import { monthlyTokenBudget } from '../../routes/fallback.js';

// Two things this locks:
//  - NaN robustness: a note whose only "number" is a URL's dots ("console.groq.com")
//    must not produce NaN (one NaN nulled the whole summed totalBudget → the fallback
//    budget bar vanished fleet-wide, 2026-07-15).
//  - Honest display (Adam 2026-07-15): only a genuine monthly-TOKEN figure (M/K unit)
//    returns a number; a bare RPM/RPD/credit count returns null so the UI shows "—"
//    instead of a fabricated token count ("20 RPM" was shown as 20, "1000 credits" as 1K).
describe('monthlyTokenBudget (fallback budget bar)', () => {
  it('returns a real number ONLY for genuine monthly-token (M/K) figures', () => {
    expect(monthlyTokenBudget('~6M/mo (200K tok/day, 20 req/day free)')).toBe(6_000_000);
    expect(monthlyTokenBudget('~30M/mo (1M tok/day free)')).toBe(30_000_000);
    expect(monthlyTokenBudget('~3M')).toBe(3_000_000);
    expect(monthlyTokenBudget('~18-45M')).toBe(45_000_000); // range → high end
  });

  it('returns null (→ "—") for RPM/credit/free-text notes — no fabricated count', () => {
    for (const s of [
      'Free: 20 RPM · 50/day (1K/day with credits)',
      '~1000 credits (signup); 40 RPM',
      'Free tier (restrictive; limits in admin console)',
      'Free tier (per-model caps, console.groq.com)',
      'Free: 1 RPM · 8/day (advanced tier)',
      '', null, undefined,
    ]) {
      expect(monthlyTokenBudget(s as any)).toBeNull();
    }
  });

  it('never yields NaN, and a mixed list sums to a finite number (nulls excluded)', () => {
    const notes = ['~6M/mo', 'Free tier (per-model caps, console.groq.com)', '~3M', 'see console.', '~1000 credits'];
    const total = notes.reduce((s, n) => s + (monthlyTokenBudget(n) ?? 0), 0);
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBe(9_000_000);
  });
});
