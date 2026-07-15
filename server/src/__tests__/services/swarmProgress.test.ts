import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordProgress, checkProgress, noProgressEnabled, _resetSwarmProgress,
} from '../../services/swarmProgress.js';

// Zero-progress circuit-breaker (RINGER, 2026-07-15). Verifies it trips on the
// degenerate-loop signature (empty output + no context growth) after LIMIT
// consecutive rounds, resets on real progress, and never trips healthy/opt-out
// traffic. LIMIT defaults to 15, INPUT_DELTA_MIN to 256.
//
// Note the first round of a session always has a large input delta (lastInput
// starts at 0), so it counts as PROGRESS — matching real data, where a session's
// opening rounds ramp context (big jumps) and only later flatten into a spin.
// So we prime with one real round, then add exactly `streak` flat no-progress
// rounds to produce a streak of `streak`.
describe('swarmProgress: zero-progress circuit-breaker', () => {
  beforeEach(() => _resetSwarmProgress());

  function prime(consumer: string, sid: string, at = 21000) {
    recordProgress(consumer, sid, at, 5); // real round: output>0 → resets streak, sets lastInput
  }
  function flatSpin(consumer: string, sid: string, rounds: number, base = 21000) {
    for (let i = 0; i < rounds; i++) recordProgress(consumer, sid, base + i * 29, 0); // +29/round < 256, 0 output
  }

  it('is enabled by default (LIMIT=15)', () => {
    expect(noProgressEnabled()).toBe(true);
  });

  it('does NOT trip before LIMIT consecutive no-progress rounds', () => {
    prime('ringer', 's1');
    flatSpin('ringer', 's1', 14);
    expect(checkProgress('ringer', 's1')).toBeNull();
  });

  it('TRIPS at LIMIT consecutive no-progress rounds (the 6M-session signature)', () => {
    prime('ringer', 's2');
    flatSpin('ringer', 's2', 15);
    const tripped = checkProgress('ringer', 's2');
    expect(tripped).not.toBeNull();
    expect(tripped!.streak).toBe(15);
    expect(tripped!.limit).toBe(15);
  });

  it('RESETS the streak on a real round (output produced)', () => {
    prime('ringer', 's3');
    flatSpin('ringer', 's3', 14);
    recordProgress('ringer', 's3', 21000 + 14 * 29, 120); // real output → reset
    flatSpin('ringer', 's3', 14, 21000 + 15 * 29);
    expect(checkProgress('ringer', 's3')).toBeNull(); // streak restarted, only 14
  });

  it('RESETS the streak on a big input jump (tool result appended) even with 0 output', () => {
    prime('ringer', 's4');
    flatSpin('ringer', 's4', 14);
    recordProgress('ringer', 's4', 40000, 0); // +~19k input = a real tool result → reset
    flatSpin('ringer', 's4', 14, 40000);
    expect(checkProgress('ringer', 's4')).toBeNull();
  });

  it('is OPT-IN: a null consumer or session is a no-op', () => {
    recordProgress('ringer', undefined, 21000, 0);
    recordProgress(undefined, 's5', 21000, 0);
    expect(checkProgress('ringer', undefined)).toBeNull();
    expect(checkProgress(undefined, 's5')).toBeNull();
  });

  it('keys on (consumer, session): a different session is independent', () => {
    prime('ringer', 'sA');
    flatSpin('ringer', 'sA', 15);
    expect(checkProgress('ringer', 'sA')).not.toBeNull();
    expect(checkProgress('ringer', 'sB')).toBeNull();
  });
});
