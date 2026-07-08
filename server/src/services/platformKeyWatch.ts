import type pg from 'pg';
import { all, get, run } from '../db/pgCompat.js';

// Adam's directive (2026-07-08): if a supplier key is removed (or disabled,
// or auto-disabled after repeated failures — any cause that leaves a
// platform with zero usable keys) and not replaced within 10 minutes, that
// platform's models should be made inactive until a working key is back.
// Deliberately checked on a cadence (piggybacked on the existing 5-min
// health-check cron via checkPlatformKeyGaps, called from health.ts) rather
// than event-driven off the DELETE/PATCH key routes — "zero usable keys" has
// several independent causes (delete, manual disable, health-check
// auto-disable) and a periodic sweep catches all of them uniformly instead
// of needing a hook at every call site that can change key state.
const GRACE_PERIOD_MS = 10 * 60 * 1000;

export async function checkPlatformKeyGaps(pool: pg.Pool): Promise<void> {
  const platforms = await all<{ platform: string }>(pool, `SELECT DISTINCT platform FROM models`);

  for (const { platform } of platforms) {
    const usable = await get<{ cnt: string }>(pool, `
      SELECT COUNT(*) as cnt FROM api_keys WHERE platform = ? AND enabled = true AND status != 'invalid'
    `, [platform]);
    const hasUsableKey = Number(usable?.cnt ?? 0) > 0;

    const watch = await get<{ keys_missing_since: string | null }>(pool, `SELECT keys_missing_since FROM platform_key_watch WHERE platform = ?`, [platform]);

    if (hasUsableKey) {
      if (watch) {
        await run(pool, `UPDATE platform_key_watch SET keys_missing_since = NULL WHERE platform = ?`, [platform]);
      }
      // Re-enable ONLY rows this mechanism disabled (disabled_reason='no_key').
      // A health-disable ('unhealthy') or a human disable ('manual') is left
      // untouched — a returning key doesn't override a different reason.
      const restored = await run(pool, `
        UPDATE models SET enabled = true, disabled_reason = NULL
        WHERE platform = ? AND enabled = false AND disabled_reason = 'no_key'
      `, [platform]);
      if (restored.changes > 0) {
        console.log(`[PlatformKeyWatch] ${platform}: usable key present, re-enabled ${restored.changes} no-key-disabled model(s)`);
      }
      continue;
    }

    if (!watch) {
      await run(pool, `INSERT INTO platform_key_watch (platform, keys_missing_since) VALUES (?, now())`, [platform]);
      continue;
    }

    if (watch.keys_missing_since === null) {
      await run(pool, `UPDATE platform_key_watch SET keys_missing_since = now() WHERE platform = ?`, [platform]);
      continue;
    }

    const elapsedMs = Date.now() - new Date(watch.keys_missing_since).getTime();
    if (elapsedMs >= GRACE_PERIOD_MS) {
      // Only disable rows currently enabled — leaves a human's 'manual'
      // disable as-is, and stamps our own reason so revival (above) only
      // touches what we turned off.
      const disabled = await run(pool, `
        UPDATE models SET enabled = false, disabled_reason = 'no_key'
        WHERE platform = ? AND enabled = true
      `, [platform]);
      if (disabled.changes > 0) {
        console.log(`[PlatformKeyWatch] ${platform}: no usable key for ${Math.round(elapsedMs / 60000)}min, disabled ${disabled.changes} model(s)`);
      }
    }
  }
}
