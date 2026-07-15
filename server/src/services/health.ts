import type pg from 'pg';
import { getPool } from '../db/index.js';
import { all, get, run } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { checkPlatformKeyGaps } from './platformKeyWatch.js';
import { recomputeModelHealth, reviveUnhealthyModels } from './modelHealth.js';
import { recheckUnreachableModels } from './livenessRecheck.js';
import type { Platform, KeyStatus } from '@freellmapi/shared/types.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CONSECUTIVE_FAILURES_TO_DISABLE = 3;
// Cheap liveness re-check runs on a much slower sub-cadence than the auth
// health check — every LIVENESS_EVERY_N ticks (~1h) — since it makes real
// (if tiny, max_tokens=1) provider calls. Keeps token spend negligible.
const LIVENESS_EVERY_N = 12;
let healthTick = 0;

// Track consecutive failures per key
const failureCount = new Map<number, number>();

export async function checkKeyHealth(keyId: number): Promise<KeyStatus> {
  const pool = getPool();
  const row = await get<any>(pool, 'SELECT * FROM api_keys WHERE id = ?', [keyId]);
  if (!row) return 'error';

  const provider = getProvider(row.platform as Platform);
  if (!provider) return 'error';

  try {
    const apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    const isValid = await provider.validateKey(apiKey);

    const status: KeyStatus = isValid ? 'healthy' : 'invalid';

    await run(pool, "UPDATE api_keys SET status = ?, last_checked_at = now() WHERE id = ?", [status, keyId]);

    if (isValid) {
      failureCount.delete(keyId);
    } else {
      const count = (failureCount.get(keyId) ?? 0) + 1;
      failureCount.set(keyId, count);

      if (count >= CONSECUTIVE_FAILURES_TO_DISABLE) {
        await run(pool, 'UPDATE api_keys SET enabled = false WHERE id = ?', [keyId]);
        console.log(`[Health] Auto-disabled key ${keyId} after ${count} consecutive failures`);
      }
    }

    return status;
  } catch (err: any) {
    // Transport errors (DNS/timeout/TLS) — provider unreachable, not necessarily
    // a bad key. Mark status='error' but do NOT increment failure counter — auto-
    // disable is reserved for confirmed 401/403 (returned by validateKey as false).
    console.error(`[Health] Key ${keyId} transport error:`, err.message);
    await run(pool, "UPDATE api_keys SET status = ?, last_checked_at = now() WHERE id = ?", ['error', keyId]);
    return 'error';
  }
}

// Self-heal auto-disabled keys (2026-07-15). A key that trips `invalid` is
// auto-disabled (enabled=false) and then falls OUT of checkAllKeys' enabled=true
// sweep — so a TRANSIENT cause (VPN egress block, brief network fault) that later
// clears would never recover without a manual re-enable. (This bit groq 2026-07-15:
// NordVPN's egress made a perfectly good key return 401 → auto-disabled → stuck.)
// Re-validate disabled+invalid keys on a slow backoff; re-enable any that now pass,
// after which checkPlatformKeyGaps (called next) revives their no_key models the
// same cycle. Only status='invalid' rows are touched, so a human who disabled a
// HEALTHY key is left alone. Uses the cheap validateKey auth check — no
// token-costing completion, safe on the 5-min cron.
export async function reviveRecoverableKeys(pool: pg.Pool): Promise<void> {
  const cands = await all<{ id: number; platform: string }>(pool, `
    SELECT id, platform FROM api_keys
    WHERE enabled = false AND status = 'invalid'
      AND (last_checked_at IS NULL OR last_checked_at < now() - interval '15 minutes')
  `);
  for (const k of cands) {
    const status = await checkKeyHealth(k.id); // re-validates + updates status/last_checked_at
    if (status === 'healthy') {
      await run(pool, 'UPDATE api_keys SET enabled = true WHERE id = ?', [k.id]);
      console.log(`[Health] key ${k.id} (${k.platform}) RECOVERED — was auto-disabled invalid, now valid again; re-enabled (its no_key models revive on the platform-key-gap check)`);
    }
  }
}

export async function checkAllKeys(): Promise<void> {
  const keys = await all<{ id: number; platform: string }>(getPool(), 'SELECT id, platform FROM api_keys WHERE enabled = true');

  console.log(`[Health] Checking ${keys.length} keys...`);

  for (const key of keys) {
    await checkKeyHealth(key.id);
  }

  // Self-heal any transiently-failed keys BEFORE the key-gap check, so a recovered
  // key's models revive in the same cycle.
  await reviveRecoverableKeys(getPool());

  await checkPlatformKeyGaps(getPool());

  // Recompute per-instance health/latency from the requests log (passive — no
  // extra provider calls) and run the daily revival poll for benched models.
  // Failures here must never sink the key-health cron, hence the try/catch.
  try {
    await recomputeModelHealth(getPool());
    await reviveUnhealthyModels(getPool());
  } catch (err: any) {
    console.error('[Health] Model-health recompute failed:', err.message);
  }

  // Cheap liveness re-check for auto-benched (unreachable) models — only every
  // Nth tick so its tiny real calls stay negligible. Token-safe per Adam's
  // "cheap probe fine, no long-context sweeps" (2026-07-11).
  healthTick++;
  if (healthTick % LIVENESS_EVERY_N === 0) {
    try {
      const { checked, revived } = await recheckUnreachableModels(getPool());
      if (checked > 0) console.log(`[Liveness] re-checked ${checked} unreachable model(s); revived ${revived.length}${revived.length ? ': ' + revived.join(', ') : ''}`);
    } catch (err: any) {
      console.error('[Liveness] recheck failed:', err.message);
    }
  }

  console.log(`[Health] Check complete.`);
}

// Found live 2026-07-08 (Adam's key-removal check): deleting an api_keys row
// is already immediately honored for routing, but failureCount above is
// never cleaned up — a permanently orphaned entry after the key is gone.
export function clearHealthState(keyId: number): void {
  failureCount.delete(keyId);
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startHealthChecker(): void {
  if (intervalId) return;
  console.log(`[Health] Starting health checker (every ${CHECK_INTERVAL_MS / 1000}s)`);
  intervalId = setInterval(() => {
    checkAllKeys().catch(err => console.error('[Health] Check failed:', err));
  }, CHECK_INTERVAL_MS);
}

export function stopHealthChecker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
