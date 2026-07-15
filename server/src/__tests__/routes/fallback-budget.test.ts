import { describe, it, expect } from 'vitest';
import { parseMonthlyBudget } from '../../routes/fallback.js';

// Regression: a monthly_token_budget note whose only "number-ish" run is dots from
// a URL (e.g. "console.groq.com") made the old parser return NaN, and ONE NaN in the
// reduce() nulled the entire totalBudget → the fallback budget bar vanished fleet-wide
// (groq "Allam 2 7b" / "Qwen3 6 27b", 2026-07-15).
describe('parseMonthlyBudget (fallback budget bar)', () => {
  it('never returns NaN — free-text with only a URL yields 0, not NaN', () => {
    const v = parseMonthlyBudget('Free tier (per-model caps, console.groq.com)');
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBe(0);
  });

  it('handles the other no-number free-text notes as 0', () => {
    for (const s of ['Free tier (restrictive; limits in admin console)', 'Free (limited-time; no published caps)', 'see console.', '', null, undefined]) {
      const v = parseMonthlyBudget(s as any);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBe(0);
    }
  });

  it('still parses real monthly-token figures', () => {
    expect(parseMonthlyBudget('~6M/mo (200K tok/day, 20 req/day free)')).toBe(6_000_000);
    expect(parseMonthlyBudget('~30M/mo (1M tok/day free)')).toBe(30_000_000);
    expect(parseMonthlyBudget('~3M')).toBe(3_000_000);
    expect(parseMonthlyBudget('~18-45M')).toBe(45_000_000); // range → high end
  });

  it('still parses the (imperfect) credits/RPM notes the same as before', () => {
    expect(parseMonthlyBudget('~1000 credits (signup); 40 RPM')).toBe(1000);
    expect(parseMonthlyBudget('Free: 20 RPM · 50/day')).toBe(20);
  });

  it('a mixed list with one un-parseable note still sums to a finite number', () => {
    const notes = ['~6M/mo', 'Free tier (per-model caps, console.groq.com)', '~3M', 'see console.'];
    const total = notes.reduce((s, n) => s + parseMonthlyBudget(n), 0);
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBe(9_000_000);
  });
});
