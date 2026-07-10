import { getPool } from '../db/index.js';
import { run } from '../db/pgCompat.js';
import type { ChatCompletionResponse } from '@freellmapi/shared/types.js';

// Passive capability observation (Adam's "collect the info the probes were
// getting, in real time as we call the models" — 2026-07-10). Instead of
// spending tokens on active probe sweeps (banned: they drain the shared free
// tier), we watch REAL production completions and record what a model
// demonstrably DID — the live, zero-extra-cost version of the tools/json_mode
// probes.
//
// Recorded as source='observed' in model_capabilities — a THIRD source
// alongside 'measured' (active probe) and 'declared' (web research). The
// router's hard capability gate accepts 'observed' the same as 'measured'
// (see router.ts) because a model that ACTUALLY returned tool_calls on real
// traffic is proof at least as strong as a synthetic probe — while still
// NEVER accepting 'declared' (an unverified spec-sheet claim), which is the
// safety property the probe work exists to protect.
//
// Discipline mirrors the probes: POSITIVE-ONLY, and only on unambiguous
// evidence. We never write supported=false from observation — absence of a
// tool_call is not disproof (the model may simply have chosen to answer
// directly), and a prose-wrapped JSON is not proof the model can't do
// json_mode. A negative signal (a model that got response_format and ignored
// it, or a measured-true tools model that 400s) is handled elsewhere by the
// suspect/re-probe path (proxy.ts's markCapabilitySuspect), not here.

export interface ObservationInput {
  hadTools: boolean;
  hadResponseFormat: boolean;
}

// Upsert one observed-true capability row. Keyed on (model_db_id, capability,
// source) — the same unique constraint recordProbeResult uses — so repeated
// observations refresh the timestamp/evidence rather than piling up rows.
async function recordObserved(modelDbId: number, capability: string, evidence: string): Promise<void> {
  await run(getPool(), `
    INSERT INTO model_capabilities (model_db_id, capability, supported, score, source, measured_at, evidence)
    VALUES (?, ?, true, 1, 'observed', now(), ?)
    ON CONFLICT (model_db_id, capability, source)
    DO UPDATE SET supported = true, score = 1, measured_at = now(),
                  evidence = EXCLUDED.evidence, suspect = false
  `, [modelDbId, capability, evidence.slice(0, 500)]);
}

// Fire-and-forget: called after a SUCCESSFUL non-streaming completion. Never
// throws into the request path (all errors caught) — telemetry must never be
// the reason a served request looks failed.
export async function observeCapabilities(
  modelDbId: number,
  input: ObservationInput,
  result: ChatCompletionResponse,
): Promise<void> {
  try {
    const message = result.choices?.[0]?.message;
    if (!message) return;

    // tools: the request offered tools AND the model came back with a real
    // tool_calls array → it genuinely supports function calling on this wire.
    if (input.hadTools && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const names = message.tool_calls.map(tc => tc.function?.name).filter(Boolean).slice(0, 3).join(',');
      await recordObserved(modelDbId, 'tools', `live: returned ${message.tool_calls.length} tool_call(s)${names ? ` (${names})` : ''}`);
    }

    // json_mode: the request asked for JSON AND the content parses cleanly as a
    // JSON object/array → the model honored response_format. (Informational for
    // the wiki today — routing gates json_mode on the provider dialect flag,
    // not this per-model row — but it's real evidence worth collecting, and the
    // exact signal ob-claude's "returned prose with a clean 200" scar needs.)
    if (input.hadResponseFormat && typeof message.content === 'string' && message.content.trim().length > 0) {
      const text = message.content.trim();
      const looksJson = (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'));
      if (looksJson) {
        try {
          JSON.parse(text);
          await recordObserved(modelDbId, 'json_mode', 'live: response_format honored, valid JSON returned');
        } catch { /* prose-wrapped or partial — not clean proof, record nothing */ }
      }
    }
  } catch (e) {
    console.error('[CapabilityObserve] Failed to record observation:', e);
  }
}
