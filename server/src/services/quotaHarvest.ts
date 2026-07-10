import { getPool } from '../db/index.js';
import { run } from '../db/pgCompat.js';

// L6 (design plan): header-harvest OWNS quota_remaining/quota_limit/reset_at
// on quota_snapshots — the research cron (P3) never writes these columns,
// only capability/score/declared-limit ones. Column ownership, not locking.

// Groq's reset headers are duration strings ("7m12s", "1.5s"); others may
// send a plain number of seconds. Best-effort parse — an unrecognized shape
// yields null (no reset time recorded) rather than a wrong guess.
function parseResetDuration(value: string): Date | null {
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && value.trim() !== '') {
    return new Date(Date.now() + asNumber * 1000);
  }
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return new Date(Date.now() + (hours * 3600 + minutes * 60 + seconds) * 1000);
}

export async function harvestQuotaHeaders(
  platform: string,
  modelId: string,
  apiKeyId: number,
  headers: Record<string, string> | undefined,
): Promise<void> {
  if (!headers) return; // provider sent nothing — not the same as zero remaining, record nothing

  // Prefer token-based quota (most actionable for LLM usage); fall back to
  // request-based if a provider only exposes that.
  const remainingRaw = headers['x-ratelimit-remaining-tokens'] ?? headers['x-ratelimit-remaining-requests'];
  const limitRaw = headers['x-ratelimit-limit-tokens'] ?? headers['x-ratelimit-limit-requests'];
  const resetRaw = headers['x-ratelimit-reset-tokens'] ?? headers['x-ratelimit-reset-requests'];

  if (remainingRaw == null && limitRaw == null) return; // nothing usable

  const quotaRemaining = remainingRaw != null ? Number(remainingRaw) : null;
  const quotaLimit = limitRaw != null ? Number(limitRaw) : null;
  const resetAt = resetRaw != null ? parseResetDuration(resetRaw) : null;

  try {
    await run(getPool(), `
      INSERT INTO quota_snapshots (platform, model_id, api_key_id, quota_remaining, quota_limit, reset_at, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, now())
      ON CONFLICT (platform, model_id, api_key_id)
      DO UPDATE SET quota_remaining = EXCLUDED.quota_remaining,
                    quota_limit = EXCLUDED.quota_limit,
                    reset_at = EXCLUDED.reset_at,
                    observed_at = now()
    `, [platform, modelId, apiKeyId, quotaRemaining, quotaLimit, resetAt]);
  } catch (e) {
    // Never let quota telemetry break the actual request path.
    console.error('[QuotaHarvest] Failed to record quota snapshot:', e);
  }

  // Passively vet the routing TPM ceiling from real traffic (Adam's "collect
  // what the probes were getting, in real time" — 2026-07-10, replaces active
  // probe sweeps). The router's structural filter (router.ts) reads
  // models.tpm_limit, NOT quota_snapshots — so a big-context model with an
  // unknown (NULL) tpm_limit is a GAMBLE: it passes the filter, then 413s on a
  // large request, burning the pool toward a spurious 422. The provider's OWN
  // per-minute TOKEN limit (x-ratelimit-limit-tokens) is exactly that ceiling,
  // declared for free on every response. Feeding it into models.tpm_limit turns
  // each NULL-tpm model into known-good (widens the pool) or known-excluded
  // (correct NO_ELIGIBLE instead of retry-forever) as its real traffic flows.
  //
  // TOKEN header ONLY — never the request-count fallback (a per-minute REQUEST
  // limit is not a token budget and must not land in tpm_limit). Guard against
  // a malformed/zero value clobbering a good limit.
  const tokenLimitRaw = headers['x-ratelimit-limit-tokens'];
  if (tokenLimitRaw != null) {
    const tokenLimit = Number(tokenLimitRaw);
    if (Number.isFinite(tokenLimit) && tokenLimit > 0) {
      try {
        await run(getPool(),
          `UPDATE models SET tpm_limit = ? WHERE platform = ? AND model_id = ?`,
          [Math.round(tokenLimit), platform, modelId],
        );
      } catch (e) {
        console.error('[QuotaHarvest] Failed to update models.tpm_limit:', e);
      }
    }
  }
}
