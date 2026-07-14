import type pg from 'pg';
import { all, get, run } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';

// Per-instance health + latency, DERIVED on a cadence from the requests log —
// NOT written on the hot path and NOT actively probed (Adam's don't-burn-quota
// constraint). Real production traffic IS the health signal: every proxied
// call already lands a row in `requests` with status + latency_ms, so we
// recompute a coarse health summary from those rows periodically. The only
// active call this module makes is the once-a-day revival poll for models it
// previously benched.
//
// The flip-window data (wsl, 2026-07-08) is why this exists: the needs-filter
// was correct but selection WITHIN the eligible set had no latency/health
// signal, so it kept landing on 9-12s heavy reasoners while sub-second
// eligible models sat idle; and dead providers cost ~15s AbortController
// timeouts each before failover. This module produces the signal the step-3
// selection engine ranks on (fast+healthy wins, flaky/slow sinks), and the
// circuit-breaker cooldown that stops failover re-paying a dead provider.

const OBSERVATION_WINDOW_MIN = 30;   // recompute health from the last N minutes of traffic
const COOLDOWN_MS = 90_000;          // circuit-break a just-failed instance for this long
const INACTIVE_AFTER_CONSECUTIVE_429 = 6; // conservative escalation (Adam's choice)
const REVIVE_POLL_MIN_AGE_MS = 24 * 60 * 60 * 1000; // daily revival poll cadence
// A free-tier DAILY/tier quota is spent — park the model this long instead of
// the 90s transient cooldown, so an exhausted model stops churning retries all
// day (the load shape a parallel Ringer swarm exposes). Env-tunable.
const QUOTA_BENCH_MS = Number(process.env.FEEDER_QUOTA_BENCH_MS ?? 6 * 60 * 60 * 1000); // 6h default

function isRateLimitOrTimeout(error: string | null): boolean {
  if (!error) return false;
  return /429|rate.?limit|too many requests|timeout|aborted|econnreset|etimedout|5\d\d\b|quota|resource_exhausted|unavailable/i.test(error);
}

interface RecentRow {
  model_db_id: number;
  platform: string;
  model_id: string;
  status: string;
  latency_ms: number;
  error: string | null;
  created_at: string;
}

// Recompute health for every model that has recent traffic. Derivation only —
// safe to run every cron tick, never touches routing decisions (step 3 reads
// what this writes). Escalates to inactive conservatively + quota-aware; the
// revival poll (below) brings benched models back.
export async function recomputeModelHealth(pool: pg.Pool): Promise<void> {
  // Pull recent non-probe traffic joined to the owning model row. is_probe is
  // excluded so probe calls don't skew production health/latency (the L2 split).
  const rows = await all<RecentRow>(pool, `
    SELECT m.id AS model_db_id, r.platform, r.model_id, r.status, r.latency_ms, r.error, r.created_at
    FROM requests r
    JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.is_probe = false AND r.created_at > now() - (? || ' minutes')::interval
    ORDER BY r.created_at ASC
  `, [OBSERVATION_WINDOW_MIN]);

  // Group by model.
  const byModel = new Map<number, RecentRow[]>();
  for (const r of rows) {
    const list = byModel.get(r.model_db_id) ?? [];
    list.push(r);
    byModel.set(r.model_db_id, list);
  }

  for (const [modelDbId, calls] of byModel) {
    const successes = calls.filter((c) => c.status === 'success');
    const successRate = calls.length > 0 ? successes.length / calls.length : null;

    // Median latency over SUCCESSFUL calls only — a failed call's latency is a
    // timeout artifact (~15s), not the model's real speed; including it would
    // wrongly penalize a fast model that had one blip.
    const latencies = successes.map((c) => c.latency_ms).filter((n) => n > 0).sort((a, b) => a - b);
    const medianLatency = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : null;

    // Consecutive rate-limit/timeout failures at the tail (most recent first).
    let consecutive429 = 0;
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i].status !== 'success' && isRateLimitOrTimeout(calls[i].error)) consecutive429++;
      else break;
    }

    const last = calls[calls.length - 1];
    const lastWasFailure = last.status !== 'success' && isRateLimitOrTimeout(last.error);
    const lastSuccess = [...successes].pop();

    // Health score: start at the success rate, floor-boosted so a model with a
    // little recent trouble isn't zeroed, then hard-drop if the tail is a run
    // of failures. Clean history → ~1.0; sustained failures → toward 0.2.
    let healthScore = successRate ?? 1;
    if (consecutive429 >= 3) healthScore = Math.min(healthScore, 0.2);
    else if (consecutive429 > 0) healthScore = Math.min(healthScore, 0.6);
    healthScore = Math.max(0, Math.min(1, healthScore));

    const cooldownUntil = lastWasFailure ? new Date(Date.now() + COOLDOWN_MS) : null;
    const status = consecutive429 >= INACTIVE_AFTER_CONSECUTIVE_429 ? 'inactive'
      : consecutive429 > 0 ? 'penalized' : 'healthy';

    await run(pool, `
      INSERT INTO model_health (model_db_id, health_score, recent_latency_ms, recent_success_rate, consecutive_429, last_429_at, last_success_at, cooldown_until, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now())
      ON CONFLICT (model_db_id) DO UPDATE SET
        health_score = EXCLUDED.health_score,
        recent_latency_ms = EXCLUDED.recent_latency_ms,
        recent_success_rate = EXCLUDED.recent_success_rate,
        consecutive_429 = EXCLUDED.consecutive_429,
        last_429_at = COALESCE(EXCLUDED.last_429_at, model_health.last_429_at),
        last_success_at = COALESCE(EXCLUDED.last_success_at, model_health.last_success_at),
        cooldown_until = EXCLUDED.cooldown_until,
        status = EXCLUDED.status,
        updated_at = now()
    `, [
      modelDbId, healthScore, medianLatency, successRate, consecutive429,
      lastWasFailure ? new Date(last.created_at) : null,
      lastSuccess ? new Date(lastSuccess.created_at) : null,
      cooldownUntil, status,
    ]);

    // Conservative escalation: sustained 429/timeout run → bench the model so
    // the pool stops trying it, with disabled_reason='health' so only THIS
    // mechanism (via the revival poll) ever brings it back — never fighting a
    // no_key or manual disable.
    if (status === 'inactive') {
      const disabled = await run(pool, `
        UPDATE models SET enabled = false, disabled_reason = 'unhealthy'
        WHERE id = ? AND enabled = true
      `, [modelDbId]);
      if (disabled.changes > 0) {
        console.log(`[ModelHealth] model ${modelDbId}: ${consecutive429} consecutive 429/timeout — benched (disabled_reason=unhealthy)`);
      }
    }
  }
}

// Bench a model a live request proved UNREACHABLE — a non-retryable 403/404 /
// "model not found" means the key can't actually serve it (Ollama Cloud 403 for
// a plan-excluded model, a stale NIM slug 404, etc). That's a persistent fact,
// not transient rate-limiting, so the model shouldn't keep leading and failing
// over every request. disabled_reason='unreachable' is deliberately NOT
// auto-revived by reviveUnhealthyModels ('unhealthy') or platformKeyWatch
// ('no_key'), and never overrides a human 'manual' bench — it clears only when
// the model is re-probed/re-enabled. Guarded so it only ever benches a model
// that's currently live (disabled_reason NULL) or already 'unreachable'.
export async function benchUnreachableModel(pool: pg.Pool, modelDbId: number, evidence: string): Promise<void> {
  await run(pool, `
    UPDATE models SET enabled = false, disabled_reason = 'unreachable'
    WHERE id = ? AND (disabled_reason IS NULL OR disabled_reason = 'unreachable')
  `, [modelDbId]);
  console.log(`[ModelHealth] model ${modelDbId} benched (disabled_reason=unreachable): ${evidence.slice(0, 100)}`);
}

// Park a model whose free-tier DAILY/tier quota is exhausted (distinct from a
// transient per-minute 429). Set from the proxy hot path the moment a quota-class
// error is seen — immediate, so a burst can't keep re-hitting it. The router
// skips any model with quota_exhausted_until in the future. Upserts ONLY that
// column, so the cron recompute (which never writes it) preserves the parking;
// it lapses naturally at expiry and a subsequent good call lets the model back.
export async function setQuotaExhausted(pool: pg.Pool, modelDbId: number, evidence: string): Promise<void> {
  const until = new Date(Date.now() + QUOTA_BENCH_MS);
  try {
    await run(pool, `
      INSERT INTO model_health (model_db_id, quota_exhausted_until, updated_at)
      VALUES (?, ?, now())
      ON CONFLICT (model_db_id) DO UPDATE SET quota_exhausted_until = EXCLUDED.quota_exhausted_until, updated_at = now()
    `, [modelDbId, until]);
    console.log(`[ModelHealth] model ${modelDbId} quota-parked until ${until.toISOString()}: ${evidence.slice(0, 80)}`);
  } catch (e) {
    console.error('[ModelHealth] setQuotaExhausted failed:', e);
  }
}

// Daily revival poll — the ONE active call this module makes. For each model
// benched with disabled_reason='unhealthy' whose health row is stale enough,
// send one cheap reachability ping; a clean response revives it. A single
// lucky call is enough here (unlike routing, this is just "is it back at all").
export async function reviveUnhealthyModels(pool: pg.Pool): Promise<void> {
  const benched = await all<{ id: number; platform: string; model_id: string; updated_at: string | null }>(pool, `
    SELECT m.id, m.platform, m.model_id, h.updated_at
    FROM models m
    LEFT JOIN model_health h ON h.model_db_id = m.id
    WHERE m.enabled = false AND m.disabled_reason = 'unhealthy'
  `);

  for (const model of benched) {
    // Respect the daily cadence — don't re-poll a model we checked recently.
    if (model.updated_at && Date.now() - new Date(model.updated_at).getTime() < REVIVE_POLL_MIN_AGE_MS) continue;

    const keyRow = await get<{ encrypted_key: string; iv: string; auth_tag: string }>(pool,
      `SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = true AND status != 'invalid' LIMIT 1`,
      [model.platform]
    );
    const provider = getProvider(model.platform as any);
    if (!keyRow || !provider) continue; // no key → platformKeyWatch's concern, not ours

    try {
      const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
      const result = await provider.chatCompletion(apiKey, [{ role: 'user', content: 'hi' }], model.model_id, { max_tokens: 5 });
      if (result.choices?.length) {
        await run(pool, `UPDATE models SET enabled = true, disabled_reason = NULL WHERE id = ? AND disabled_reason = 'unhealthy'`, [model.id]);
        await run(pool, `UPDATE model_health SET status = 'healthy', health_score = 1, consecutive_429 = 0, cooldown_until = NULL, updated_at = now() WHERE model_db_id = ?`, [model.id]);
        console.log(`[ModelHealth] model ${model.id} (${model.platform}/${model.model_id}) revived — reachable again`);
      }
    } catch {
      // Still down — bump updated_at so the daily cadence holds, leave benched.
      await run(pool, `UPDATE model_health SET updated_at = now() WHERE model_db_id = ?`, [model.id]);
    }
  }
}

export interface ModelHealthRow {
  model_db_id: number;
  health_score: number;
  recent_latency_ms: number | null;
  recent_success_rate: number | null;
  status: string;
  cooldown_until: string | null;
  quota_exhausted_until: string | null;
}

// Read helper for the selection engine (step 3) and the wiki's live pills.
export async function getHealthMap(pool: pg.Pool): Promise<Map<number, ModelHealthRow>> {
  const rows = await all<ModelHealthRow>(pool, `
    SELECT model_db_id, health_score, recent_latency_ms, recent_success_rate, status, cooldown_until, quota_exhausted_until FROM model_health
  `);
  return new Map(rows.map((r) => [r.model_db_id, r]));
}
