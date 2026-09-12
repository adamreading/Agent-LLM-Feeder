import type pg from 'pg';
import { all, run } from '../db/pgCompat.js';
import { normalizeModelId } from './modelCanon.js';

// ZERO model-token parameter-count backfill (Adam, 2026-09-12). params_b feeds
// two routing decisions — the quality-lift size tilt (sizeFactor) and the
// big100 hard band (params_b >= 100 || frontier) — but only ~70/214 enabled
// models carried it, so big100's pool was thin and equal-score models of wildly
// different size tied. Two free sources, in order:
//   1. parseParamsB(): the size token already in the model id/name (30b, 550b,
//      120b-a12b, 8x22b …). Deterministic, no network. Bails to null on MoE
//      expert markers it can't total (…-128e) so it never guesses a wrong TOTAL.
//   2. HuggingFace GET /api/models/<repo> → safetensors.total (exact params).
//      Matched exact-normalised only (same rule as the canonical/leaderboard
//      matchers — a wrong repo = a wrong size), bounded per run.
// Never overwrites an existing non-null params_b (curated/verified values win).

const HF_SEARCH = 'https://huggingface.co/api/models';
const FETCH_TIMEOUT_MS = 20_000;

// Total parameters in billions from the id/name, or null when the name can't be
// trusted for a TOTAL. Rules, conservative by construction:
//  - "NxMb"  (Mixtral style)         → N*M   (8x22b = 176)
//  - "…-Ne"  MoE expert count present → null  (17b-128e is 400B total, not 17B)
//  - otherwise the MAX "NNb" token that is NOT an active-params token ("aNNb")
export function parseParamsB(id: string, name = ''): number | null {
  const s = `${id} ${name}`.toLowerCase().replace(/:free$/, '');
  const moe = s.match(/(\d+)\s*x\s*(\d+)\s*b\b/);
  if (moe) return Math.round(Number(moe[1]) * Number(moe[2]));
  if (/[-_/ ]\d+\s*e\b/.test(s)) return null; // NNe experts → total not derivable from the name
  const toks = [...s.matchAll(/(?<![a-z0-9.])(a?)(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/g)];
  const totals = toks.filter((t) => t[1] !== 'a').map((t) => parseFloat(t[2])).filter((v) => v >= 0.1 && v <= 100000);
  if (!totals.length) return null;
  return Math.max(1, Math.round(Math.max(...totals)));
}

// The HF-search leaf: drop a leading @vendor/ (cloudflare) and any :free, keep
// the last path segment so "nvidia/nemotron-3-ultra-550b-a55b" searches
// "nemotron-3-ultra-550b-a55b".
function hfQueryLeaf(modelId: string): string {
  let s = modelId.replace(/:free$/, '').replace(/^@[^/]+\//, '');
  const parts = s.split('/');
  return parts[parts.length - 1];
}

async function hfGet(url: string): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Agent-LLM-Feeder/params-backfill' }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// Two-step: the SEARCH endpoint returns repos but NOT safetensors, so search to
// find exact-leaf candidates, then GET each candidate's individual model page
// (which carries safetensors.total). Bounded to the first 3 exact matches.
async function hfLookupParamsB(modelId: string): Promise<number | null> {
  const leaf = hfQueryLeaf(modelId);
  const want = normalizeModelId(modelId);
  const list = await hfGet(`${HF_SEARCH}?search=${encodeURIComponent(leaf)}&limit=10`);
  if (!Array.isArray(list)) return null;
  const cands = list
    .map((m) => (m?.id ?? m?.modelId ?? '') as string)
    .filter((repo) => repo && normalizeModelId(repo.split('/').pop() ?? repo) === want)
    .slice(0, 3);
  for (const repo of cands) {
    const m = await hfGet(`${HF_SEARCH}/${repo}`);
    const total = Number(m?.safetensors?.total);
    if (Number.isFinite(total) && total > 0) return Math.max(1, Math.round(total / 1e9));
  }
  return null;
}

export interface ParamsBackfillSummary { fromName: number; fromHf: number; hfTried: number; stillMissing: number }

export async function backfillParams(
  pool: pg.Pool,
  opts: { hfLimit?: number; enabledOnly?: boolean; log?: (m: string) => void } = {},
): Promise<ParamsBackfillSummary> {
  const log = opts.log ?? ((m: string) => console.log(`[ParamsBackfill] ${m}`));
  const hfLimit = opts.hfLimit ?? 40;
  const summary: ParamsBackfillSummary = { fromName: 0, fromHf: 0, hfTried: 0, stillMissing: 0 };

  // Pass 1 — free id-token parse, over EVERY missing row (deterministic, no network).
  const allRows = await all<{ id: number; model_id: string; display_name: string | null }>(pool,
    `SELECT id, model_id, display_name FROM models WHERE params_b IS NULL`);
  for (const r of allRows) {
    const p = parseParamsB(r.model_id, r.display_name ?? '');
    if (p != null) { await run(pool, `UPDATE models SET params_b = ? WHERE id = ? AND params_b IS NULL`, [p, r.id]); summary.fromName++; }
  }

  // Pass 2 — HF authoritative, bounded, targeting ROUTABLE rows when enabledOnly
  // (so the budget isn't soaked by ~1,000 delisted/non-chat rows). De-dupe by
  // model_id so two providers of the same model cost one lookup; write to all.
  const stillMissing = await all<{ id: number; model_id: string; display_name: string | null }>(pool,
    `SELECT id, model_id, display_name FROM models
      WHERE params_b IS NULL ${opts.enabledOnly ? "AND enabled = true AND kind = 'chat'" : ''}
      ORDER BY (enabled AND kind = 'chat') DESC`);
  const seen = new Map<string, number | null>();
  let tried = 0;
  for (const r of stillMissing) {
    if (tried >= hfLimit) break;
    let p = seen.get(r.model_id);
    if (p === undefined) { p = await hfLookupParamsB(r.model_id); seen.set(r.model_id, p); tried++; summary.hfTried++; }
    if (p != null) { await run(pool, `UPDATE models SET params_b = ? WHERE model_id = ? AND params_b IS NULL`, [p, r.model_id]); summary.fromHf++; }
  }

  const missRow = await all<{ n: string }>(pool,
    `SELECT count(*) n FROM models WHERE params_b IS NULL ${opts.enabledOnly ? "AND enabled = true AND kind = 'chat'" : ''}`);
  summary.stillMissing = Number(missRow[0]?.n ?? 0);
  log(`params: +${summary.fromName} from name, +${summary.fromHf} from HF (${summary.hfTried} looked up), ${summary.stillMissing} still missing`);
  return summary;
}
