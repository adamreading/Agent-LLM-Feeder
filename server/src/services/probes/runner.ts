import { getPool } from '../../db/index.js';
import { all, get, run } from '../../db/pgCompat.js';
import { getProvider } from '../../providers/index.js';
import { decrypt } from '../../lib/crypto.js';
import type { BaseProvider } from '../../providers/base.js';

export interface ProbeContext {
  provider: BaseProvider;
  apiKey: string;
  modelId: string;
  modelDbId: number;
  platform: string;
}

export interface ProbeOutcome {
  passed: boolean;
  latencyMs: number;
  evidence: string;
  dialect?: string;
}

export type ProbeFn = (ctx: ProbeContext) => Promise<ProbeOutcome>;

// Probes call the provider DIRECTLY — never through routeRequest/the
// capability filter. A probe's whole purpose is to establish whether a
// capability works; routing it through the very gate it's meant to inform
// would mean an unconfirmed capability can never be probed in the first
// place (the L1 "classifier bypasses routing" pattern, applied here).
export async function getProbeContext(platform: string): Promise<ProbeContext | null> {
  const pool = getPool();
  const keyRow = await get<{ id: number; encrypted_key: string; iv: string; auth_tag: string }>(pool,
    `SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ? AND enabled = true AND status != 'invalid' LIMIT 1`,
    [platform]
  );
  if (!keyRow) return null;

  const modelRow = await get<{ id: number; model_id: string }>(pool,
    `SELECT id, model_id FROM models WHERE platform = ? AND enabled = true ORDER BY intelligence_rank ASC LIMIT 1`,
    [platform]
  );
  if (!modelRow) return null;

  const provider = getProvider(platform as any);
  if (!provider) return null;

  return {
    provider,
    apiKey: decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag),
    modelId: modelRow.model_id,
    modelDbId: modelRow.id,
    platform,
  };
}

export async function recordProbeResult(
  probeCapability: string,
  ctx: ProbeContext,
  outcome: ProbeOutcome,
  isPaidProbe: boolean,
): Promise<void> {
  const pool = getPool();

  // probe_bank row: one per capability, versioned as data (not hardcoded
  // per-model) — get-or-create the "current" probe definition row for this
  // capability so probe_results has something to reference.
  let probeBankRow = await get<{ id: number }>(pool,
    `SELECT id FROM probe_bank WHERE capability = ? AND active = true ORDER BY version DESC LIMIT 1`,
    [probeCapability]
  );
  if (!probeBankRow) {
    const inserted = await get<{ id: number }>(pool, `
      INSERT INTO probe_bank (version, capability, prompt, is_paid_probe, active)
      VALUES (1, ?, ?, ?, true)
      RETURNING id
    `, [probeCapability, JSON.stringify({ method: probeCapability }), isPaidProbe]);
    probeBankRow = inserted;
  }

  await run(pool, `
    INSERT INTO probe_results (probe_id, model_db_id, passed, latency_ms, raw_response, measured_at)
    VALUES (?, ?, ?, ?, ?, now())
  `, [probeBankRow!.id, ctx.modelDbId, outcome.passed, outcome.latencyMs, outcome.evidence.slice(0, 2000)]);

  // Upsert the MEASURED fact into model_capabilities — this is the row the
  // router will eventually consult in preference over a 'declared' one.
  await run(pool, `
    INSERT INTO model_capabilities (model_db_id, capability, supported, dialect, score, source, measured_at, evidence)
    VALUES (?, ?, ?, ?, ?, 'measured', now(), ?)
    ON CONFLICT (model_db_id, capability, source)
    DO UPDATE SET supported = EXCLUDED.supported, dialect = EXCLUDED.dialect,
                  score = EXCLUDED.score, measured_at = now(), evidence = EXCLUDED.evidence,
                  suspect = false
  `, [ctx.modelDbId, probeCapability, outcome.passed, outcome.dialect ?? null, outcome.passed ? 1 : 0, outcome.evidence.slice(0, 500)]);
}

// L9 runtime feedback: a production call that fails on a declared capability
// marks that (model, capability) row SUSPECT, triggering re-probe rather
// than silently trusting stale data forever.
export async function markCapabilitySuspect(modelDbId: number, capability: string): Promise<void> {
  await run(getPool(), `
    UPDATE model_capabilities SET suspect = true
    WHERE model_db_id = ? AND capability = ?
  `, [modelDbId, capability]);
}

export async function getSuspectCapabilities(): Promise<Array<{ modelDbId: number; platform: string; modelId: string; capability: string }>> {
  return all(getPool(), `
    SELECT mc.model_db_id AS "modelDbId", m.platform, m.model_id AS "modelId", mc.capability
    FROM model_capabilities mc
    JOIN models m ON m.id = mc.model_db_id
    WHERE mc.suspect = true
  `);
}
