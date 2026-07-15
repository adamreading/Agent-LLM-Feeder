import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb, getPool } from '../../db/index.js';
import { run } from '../../db/pgCompat.js';
import { createTestDb } from '../testDb.js';
import {
  declareBudget, checkBudget, recordSpend, peekBudget, _resetSwarmBudget,
} from '../../services/swarmBudget.js';

// Per-run token hard-cap store (RINGER, 2026-07-15). Verifies the contract:
// opt-in, set-once/lower-only, fail-open, seed-from-log, and the over-budget gate.
describe('swarmBudget: per-run token hard cap', () => {
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

  beforeEach(async () => {
    await run(getPool(), 'DELETE FROM requests');
    _resetSwarmBudget();
  });

  it('is OPT-IN: an undeclared run is unlimited (checkBudget null)', () => {
    expect(checkBudget('ringer', 'run-x')).toBeNull();
  });

  it('recordSpend is a no-op for an undeclared run (never starts tracking)', () => {
    recordSpend('ringer', 'run-x', 999_999);
    expect(checkBudget('ringer', 'run-x')).toBeNull();
    expect(peekBudget('ringer', 'run-x')).toBeNull();
  });

  it('declares a ceiling; under budget = allowed, at/over = blocked', async () => {
    await declareBudget(getPool(), 'ringer', 'run-1', 100);
    expect(checkBudget('ringer', 'run-1')).toBeNull(); // spent 0 < 100
    recordSpend('ringer', 'run-1', 60);
    expect(checkBudget('ringer', 'run-1')).toBeNull(); // 60 < 100
    recordSpend('ringer', 'run-1', 40);
    // 100 >= 100 → over (gate is >=, terminal)
    expect(checkBudget('ringer', 'run-1')).toEqual({ spent: 100, budget: 100 });
  });

  it('is SET-ONCE / LOWER-ONLY: a second declare can only reduce the ceiling', async () => {
    await declareBudget(getPool(), 'ringer', 'run-2', 100);
    let r = await declareBudget(getPool(), 'ringer', 'run-2', 40); // lower
    expect(r.budget).toBe(40);
    r = await declareBudget(getPool(), 'ringer', 'run-2', 999); // raise attempt ignored
    expect(r.budget).toBe(40);
    expect(peekBudget('ringer', 'run-2')!.budget).toBe(40);
  });

  it('SEEDS spent from the requests log on declare (survives a re-declare after restart)', async () => {
    // Two real rows for the run + one probe row (excluded) + one other run (excluded).
    await run(getPool(), `INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, consumer, run_id, is_probe) VALUES
      ('groq','m','success',30,20,'ringer','run-3',false),
      ('groq','m','success',15,5,'ringer','run-3',false),
      ('groq','m','success',500,500,'ringer','run-3',true),
      ('groq','m','success',777,777,'ringer','other',false)`);
    const r = await declareBudget(getPool(), 'ringer', 'run-3', 1000);
    expect(r.spent).toBe(70); // 50 + 20, probe + other-run excluded
    expect(checkBudget('ringer', 'run-3')).toBeNull(); // 70 < 1000
  });

  it('keys on (consumer, run_id): same run id under a different consumer is separate', async () => {
    await declareBudget(getPool(), 'ringer', 'dup', 10);
    recordSpend('ringer', 'dup', 10);
    expect(checkBudget('ringer', 'dup')).toEqual({ spent: 10, budget: 10 });
    expect(checkBudget('other', 'dup')).toBeNull(); // different consumer, undeclared
  });
});
