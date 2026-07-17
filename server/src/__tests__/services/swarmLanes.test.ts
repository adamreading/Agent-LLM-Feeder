import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Import with a short idle window so expiry is testable without a long wait.
// (Env is read at module load; set it before the dynamic import. Vitest
// isolates the module registry per test file, so this instance reads 80ms.)
let SL: typeof import('../../services/swarmLanes.js');
beforeAll(async () => {
  process.env.FEEDER_SWARM_LANE_IDLE_MS = '80';
  process.env.FEEDER_SWARM_CONSUMERS = 'ringer';
  SL = await import('../../services/swarmLanes.js');
});
beforeEach(() => SL._resetSwarmLanes());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('swarmLanes', () => {
  it('isSwarmConsumer honours the configured set (case-insensitive)', () => {
    expect(SL.isSwarmConsumer('ringer')).toBe(true);
    expect(SL.isSwarmConsumer('RINGER')).toBe(true);
    expect(SL.isSwarmConsumer('hermes')).toBe(false);
    expect(SL.isSwarmConsumer(null)).toBe(false);
  });

  it('recognises sub-labels of a swarm consumer (ringer-research), but not lookalikes', () => {
    // Regression 2026-07-17: 'ringer-research' (distinct augment label) fell out
    // of the swarm set (exact-match 'ringer' only) → anti-affinity disengaged.
    expect(SL.isSwarmConsumer('ringer-research')).toBe(true);
    expect(SL.isSwarmConsumer('ringer-anything')).toBe(true);
    expect(SL.swarmGroup('ringer-research')).toBe('ringer');
    expect(SL.swarmGroup('RINGER-Research')).toBe('ringer');
    // A lookalike with no group boundary is NOT a swarm consumer.
    expect(SL.isSwarmConsumer('ringerx')).toBe(false);
    expect(SL.swarmGroup('hermes')).toBe(null);
  });

  it('sub-labels share ONE anti-affinity group (ringer vs ringer-research spread apart)', () => {
    SL.recordLane('session:a', 'ringer', 'groq');
    SL.recordLane('session:b', 'ringer-research', 'google');
    // The research worker must avoid the plain-ringer worker's platform and vice
    // versa — they are one swarm app, so a new sibling of either sees BOTH.
    expect([...SL.heldPlatformsExcluding('session:c', 'ringer-research')].sort()).toEqual(['google', 'groq']);
    expect([...SL.heldPlatformsExcluding('session:a', 'ringer-research')]).toEqual(['google']);
    expect([...SL.heldPlatformsExcluding('session:b', 'ringer')]).toEqual(['groq']);
  });

  it('records a lane and reports hasLane', () => {
    expect(SL.hasLane('session:a')).toBe(false);
    SL.recordLane('session:a', 'ringer', 'groq');
    expect(SL.hasLane('session:a')).toBe(true);
  });

  it('heldPlatformsExcluding returns SIBLING platforms (same consumer), never the session itself', () => {
    SL.recordLane('session:a', 'ringer', 'groq');
    SL.recordLane('session:b', 'ringer', 'google');
    // a sees b's platform, not its own
    expect([...SL.heldPlatformsExcluding('session:a', 'ringer')]).toEqual(['google']);
    expect([...SL.heldPlatformsExcluding('session:b', 'ringer')]).toEqual(['groq']);
  });

  it('groups by consumer — a different consumer does not anti-affine', () => {
    SL.recordLane('session:a', 'ringer', 'groq');
    SL.recordLane('session:x', 'other', 'nvidia'); // different consumer
    // ringer session ignores the other-consumer lane
    expect([...SL.heldPlatformsExcluding('session:b', 'ringer')]).toEqual(['groq']);
  });

  it('heldPlatforms returns every held platform (all consumers) for capacity', () => {
    SL.recordLane('session:a', 'ringer', 'groq');
    SL.recordLane('session:b', 'ringer', 'google');
    expect([...SL.heldPlatforms()].sort()).toEqual(['google', 'groq']);
  });

  it('expires an idle lane (err-long window, but here 80ms) so a dead worker frees its platform', async () => {
    SL.recordLane('session:a', 'ringer', 'groq');
    expect(SL.hasLane('session:a')).toBe(true);
    await sleep(130);
    expect(SL.hasLane('session:a')).toBe(false);
    expect(SL.heldPlatforms().size).toBe(0);
  });

  it('recordLane refreshes lastUsed, keeping a busy lane alive past the idle window', async () => {
    SL.recordLane('session:a', 'ringer', 'groq');
    await sleep(50);
    SL.recordLane('session:a', 'ringer', 'groq'); // refresh before expiry
    await sleep(50);
    expect(SL.hasLane('session:a')).toBe(true); // 100ms elapsed but refreshed at 50
  });

  it('withAssignLock serialises concurrent critical sections (no interleave — the race fix)', async () => {
    const events: string[] = [];
    const task = (n: number) => SL.withAssignLock(async () => {
      events.push(`start${n}`);
      await sleep(15);
      events.push(`end${n}`);
    });
    await Promise.all([task(1), task(2), task(3)]);
    // Serialised: every start is immediately followed by its OWN end.
    expect(events).toEqual(['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
  });

  it('withAssignLock keeps the chain alive after a section throws', async () => {
    await expect(SL.withAssignLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // next section still runs
    const r = await SL.withAssignLock(async () => 42);
    expect(r).toBe(42);
  });
});
