import type pg from 'pg';
import { all, get, run } from '../db/pgCompat.js';
import { normalizeModelId } from './modelCanon.js';
import { recordTaskScore } from './taskScores.js';

// ZERO-TOKEN external quality priors for routing (Adam, 2026-09-12: "find an
// efficient, free way … avoid blowing all the free tokens on researching every
// model deeply").
//
// WHY: until 2026-09-12 every `task_scores` row driving the router's dominant
// term (TASK_QUALITY_WEIGHT=20) was written by the web-research WRITER MODEL —
// an LLM's 0-100 guess from search snippets, stored as source='benchmark'.
// Measured: a speech-to-text model scored coding=1.00 off a newsletter, an OCR
// model overall=1.00, Lyria (music) creative=0.80; 75 of 175 enabled models tied
// at 0.80-0.89; Pearson(score, live success) = -0.27. Those rows are now
// source='research_estimate' and count at reduced confidence (router.ts
// RESEARCH_PRIOR_CONFIDENCE); this module supplies the real prior.
//
// SOURCES (both plain HTTP GETs — no completion tokens, ever):
//   1. LMArena (arena.ai) — the human-preference Elo leaderboard. The text
//      leaderboard has one page per category and each page EMBEDS its ratings
//      in the HTML payload (~3 MB), so 8 GETs cover feeder's whole task-type
//      taxonomy (which was modelled on these categories in the first place).
//      No key. Scrape-shaped, so the parser is defensive and a page that yields
//      nothing writes nothing (never wipes existing scores).
//   2. Artificial Analysis — free API (1,000 req/day, x-api-key, attribution
//      required: https://artificialanalysis.ai/). ONE GET returns every model's
//      Intelligence / Coding / Math index. Only runs when
//      ARTIFICIAL_ANALYSIS_API_KEY is set (Adam's free sign-up); skipped otherwise.
//
// CADENCE: weekly (leaderboardSyncScheduler) — leaderboards move slowly and
// this must stay cheap. Manual: `npm run leaderboard` / POST /api/catalog/leaderboard.
//
// MATCHING: exact-only on normalizeModelId (the same conservative rule the
// canonical matcher uses — a wrong match misattributes a quality score, the
// exact failure this replaces). Arena reasoning-effort variants
// (-high/-medium/-low/-thinking/-instant) collapse onto the base model and
// contribute their MEDIAN rating. Unmatched board entries are ignored — we
// only need scores for models feeder can serve.
//
// SCALE: both boards are normalised RELATIVE TO THE BEST MODEL ON THAT BOARD
// (Elo: (r-1000)/(top-1000); AA: index/top), so a 0.7 means "70% of the way to
// the best model anyone offers", consistently across sources and tasks.

export interface LeaderboardSyncSummary {
  startedAt: string;
  finishedAt: string;
  arena: { pages: number; ratings: number; matchedCanonicals: number; written: number; err?: string };
  aa: { models: number; matchedCanonicals: number; written: number; skipped?: string; err?: string };
  unmatchedSample: string[];   // board names that matched nothing (first 25) — for alias tuning
  note?: string;
}

const ARENA_BASE = 'https://arena.ai/leaderboard/text';
// arena category path → feeder task_type ('' = the overall page)
const ARENA_CATEGORIES: Array<[string, string]> = [
  ['', 'overall'],
  ['coding', 'coding'],
  ['math', 'math'],
  ['hard-prompts', 'reasoning'],          // closest arena proxy for feeder's 'reasoning'
  ['creative-writing', 'creative_writing'],
  ['instruction-following', 'instruction_following'],
  ['longer-query', 'long_query'],
  ['multi-turn', 'multi_turn'],
];
const ARENA_ELO_FLOOR = 1000;             // an Elo at/below this scores 0
const AA_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';
const FETCH_TIMEOUT_MS = 45_000;
// Name-normalisation layers for matching a BOARD name to a feeder canonical. Each
// is a spelling difference, not a different model: reasoning-effort variants,
// quantisation suffixes, a vendor prefix (only vendors whose name is NOT also a
// model family — 'deepseek-v3' must not become 'v3'), instruct/chat suffixes.
const VARIANT_SUFFIX = /-(high|medium|low|thinking|instant|nothinking|non-thinking|no-thinking)$/i;
const QUANT_SUFFIX = /-(nvfp4|fp8|fp16|bf16|int4|int8|gguf|awq|w4a16)$/i;
const VENDOR_PREFIX = /^(nvidia|google|meta|meta-llama|openai|anthropic|tencent|hunyuan|microsoft|xai|x-ai|nousresearch|inclusionai|liquidai|moonshotai|deepseek-ai|zai|z-ai|zhipuai|alibaba|cohere|amazon|ibm|ai21)-/i;
const TUNE_SUFFIX = /-(it|instruct|chat)$/i;

// Ordered, deduped list of normalised keys for one name — most specific first.
// Used for BOTH sides: every feeder canonical/instance name is indexed under all
// its variants, and a board name is resolved by trying its variants in order.
// Two different canonicals collapsing onto one key make that key AMBIGUOUS and
// it is refused (see resolveBoardName) — conservative by construction.
export function keyVariants(raw: string): string[] {
  const out: string[] = [];
  const push = (s: string) => { const k = normalizeModelId(s); if (k && !out.includes(k)) out.push(k); };
  let s = raw.trim().replace(/\s*\([^)]*\)\s*$/, ''); // "gemini-3-flash (thinking-minimal)" → base
  push(s);
  s = s.replace(QUANT_SUFFIX, ''); push(s);
  s = s.replace(VARIANT_SUFFIX, ''); push(s);
  const v = s.replace(VENDOR_PREFIX, ''); if (v !== s && v.length >= 6) { s = v; push(s); }
  const t = s.replace(TUNE_SUFFIX, ''); if (t !== s) push(t);
  return out;
}

let running = false;

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Agent-LLM-Feeder/leaderboard-sync (+https://github.com/adamreading/Agent-LLM-Feeder)', ...headers }, signal: ctrl.signal });
    return { status: res.status, text: await res.text() };
  } finally { clearTimeout(t); }
}

export interface ArenaEntry { name: string; rating: number; rank: number | null; votes: number | null }

// Pull {name, rating, rank, votes} records out of an arena.ai leaderboard page.
// The page is a Next.js RSC payload: JSON with escaped quotes inside <script>
// strings. Each model object carries "publicName"/"modelDisplayName" and a
// "rating"; a model can appear twice (style-control variants of the same
// score) — first occurrence wins. Fields are located by NEAREST occurrence to
// the rating (last before / first after), so a neighbouring record's name can't
// be picked up.
export function parseArenaPage(html: string): ArenaEntry[] {
  const u = html.replace(/\\"/g, '"');
  const out: ArenaEntry[] = [];
  const seen = new Set<string>();
  const re = /"rating":([0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(u))) {
    const at = m.index;
    const back = u.slice(Math.max(0, at - 700), at);
    const fwd = u.slice(at, at + 400);
    const nearest = (key: string): string | null => {
      const r = new RegExp(`"${key}":"?([^",}]+)"?`, 'g');
      let last: RegExpExecArray | null = null, x: RegExpExecArray | null;
      while ((x = r.exec(back))) last = x;
      const dBack = last ? back.length - last.index : Infinity;
      r.lastIndex = 0;
      const first = r.exec(fwd);
      const dFwd = first ? first.index : Infinity;
      if (dBack === Infinity && dFwd === Infinity) return null;
      return dBack <= dFwd ? last![1] : first![1];
    };
    const name = nearest('publicName') ?? nearest('modelDisplayName');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const rank = nearest('rank'), votes = nearest('votes');
    out.push({ name, rating: Number(m[1]), rank: rank != null && /^\d+$/.test(rank) ? Number(rank) : null, votes: votes != null && /^\d+$/.test(votes) ? Number(votes) : null });
  }
  return out;
}

// Build the exact-match index: normalised key → canonical ids. Keys come from
// every canonical's slug + name + EVERY instance model_id (enabled or not), so a
// board name matches whichever spelling any provider uses.
// key → (canonical id → the LEAST-stripped variant level at which that canonical
// produced this key; 0 = its exact spelling). Levels matter: 'gemma-4-31b' (one
// canonical, exact) and 'gemma-4-31b-it' (another, reaches the same key only
// after stripping '-it') must not be treated as a tie — the exact spelling wins.
export type CanonicalIndex = Map<string, Map<number, number>>;

export async function buildCanonicalIndex(pool: pg.Pool): Promise<CanonicalIndex> {
  const idx: CanonicalIndex = new Map();
  const add = (name: string, id: number) => {
    keyVariants(name).forEach((k, level) => {
      const m = idx.get(k) ?? new Map<number, number>();
      m.set(id, Math.min(m.get(id) ?? Infinity, level));
      idx.set(k, m);
    });
  };
  const canons = await all<{ id: number; name: string; slug: string }>(pool, `SELECT id, name, slug FROM canonical_models`);
  for (const c of canons) { add(c.slug, c.id); add(c.name, c.id); }
  const inst = await all<{ canonical_model_id: number; model_id: string }>(pool,
    `SELECT canonical_model_id, model_id FROM models WHERE canonical_model_id IS NOT NULL`);
  for (const r of inst) add(r.model_id, r.canonical_model_id);
  return idx;
}

// Resolve a board name: try its key variants most-specific first; at each key,
// only the canonicals that reached it at the LOWEST level compete; exactly one
// → match. Two canonicals tied at the same level share a spelling at that
// normalisation — ambiguous, refuse rather than guess.
export function resolveBoardName(idx: CanonicalIndex, boardName: string): number[] {
  for (const k of keyVariants(boardName)) {
    const m = idx.get(k);
    if (!m || m.size === 0) continue;
    const minLevel = Math.min(...m.values());
    const best = [...m.entries()].filter(([, lvl]) => lvl === minLevel).map(([id]) => id);
    if (best.length === 1) return best;
  }
  return [];
}
const canonicalIndex = buildCanonicalIndex;
const resolve = resolveBoardName;

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export async function runLeaderboardSync(pool: pg.Pool, opts: { log?: (m: string) => void } = {}): Promise<LeaderboardSyncSummary> {
  const log = opts.log ?? ((m: string) => console.log(`[LeaderboardSync] ${m}`));
  const startedAt = new Date().toISOString();
  const summary: LeaderboardSyncSummary = {
    startedAt, finishedAt: startedAt,
    arena: { pages: 0, ratings: 0, matchedCanonicals: 0, written: 0 },
    aa: { models: 0, matchedCanonicals: 0, written: 0 },
    unmatchedSample: [],
  };
  if (running) { summary.note = 'already running — skipped'; return summary; }
  running = true;
  const unmatched = new Set<string>();
  try {
    const idx = await canonicalIndex(pool);

    // ── 1. LMArena ──────────────────────────────────────────────────────────
    try {
      const matchedArena = new Set<number>();
      for (const [path, taskType] of ARENA_CATEGORIES) {
        const url = path ? `${ARENA_BASE}/${path}` : ARENA_BASE;
        let entries: ArenaEntry[] = [];
        try {
          const r = await fetchText(url);
          if (r.status !== 200) { log(`arena ${taskType}: HTTP ${r.status} — skipped`); continue; }
          entries = parseArenaPage(r.text);
        } catch (e: any) { log(`arena ${taskType}: fetch failed (${e?.message ?? e}) — skipped`); continue; }
        if (entries.length < 20) { log(`arena ${taskType}: only ${entries.length} ratings parsed — page shape changed? skipped`); continue; }
        summary.arena.pages++; summary.arena.ratings += entries.length;
        const top = Math.max(...entries.map((e) => e.rating));
        // group board entries per canonical (variants collapse here)
        const perCanon = new Map<number, { ratings: number[]; rank: number | null; votes: number; names: string[] }>();
        for (const e of entries) {
          const ids = resolve(idx, e.name);
          if (!ids.length) { unmatched.add(e.name); continue; }
          const g = perCanon.get(ids[0]) ?? { ratings: [], rank: null, votes: 0, names: [] };
          g.ratings.push(e.rating); g.names.push(e.name); g.votes += e.votes ?? 0;
          if (e.rank != null && (g.rank == null || e.rank < g.rank)) g.rank = e.rank;
          perCanon.set(ids[0], g);
        }
        for (const [canonId, g] of perCanon) {
          const score = clamp01((median(g.ratings) - ARENA_ELO_FLOOR) / (top - ARENA_ELO_FLOOR));
          await recordTaskScore(pool, canonId, {
            taskType, score, rank: g.rank ?? undefined, source: 'leaderboard_arena',
            evidence: `${url} — LMArena ${taskType} Elo ${Math.round(median(g.ratings))} (top ${Math.round(top)}, ${g.votes} votes; ${g.names.join(', ')})`,
          });
          summary.arena.written++; matchedArena.add(canonId);
        }
        log(`arena ${taskType}: ${entries.length} ratings, ${perCanon.size} matched canonicals`);
      }
      summary.arena.matchedCanonicals = matchedArena.size;
    } catch (e: any) { summary.arena.err = e?.message ?? String(e); log(`arena: ${summary.arena.err}`); }

    // ── 2. Artificial Analysis (optional, keyed) ─────────────────────────────
    const aaKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    if (!aaKey) {
      summary.aa.skipped = 'ARTIFICIAL_ANALYSIS_API_KEY not set (free key: https://artificialanalysis.ai/ → Insights Platform)';
      log(`aa: skipped — ${summary.aa.skipped}`);
    } else {
      try {
        const r = await fetchText(AA_URL, { 'x-api-key': aaKey });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 120)}`);
        const body: any = JSON.parse(r.text);
        const rows: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
        summary.aa.models = rows.length;
        const AA_FIELDS: Array<[string, string]> = [
          ['artificial_analysis_intelligence_index', 'overall'],
          ['artificial_analysis_coding_index', 'coding'],
          ['artificial_analysis_math_index', 'math'],
        ];
        const matchedAa = new Set<number>();
        for (const [field, taskType] of AA_FIELDS) {
          const vals = rows.map((x) => Number(x?.evaluations?.[field])).filter((v) => Number.isFinite(v) && v > 0);
          if (!vals.length) continue;
          const top = Math.max(...vals);
          for (const x of rows) {
            const v = Number(x?.evaluations?.[field]);
            if (!Number.isFinite(v) || v <= 0) continue;
            const names = [x?.slug, x?.name, x?.id].filter((s) => typeof s === 'string' && s) as string[];
            let ids: number[] = [];
            for (const n of names) { ids = resolve(idx, n); if (ids.length) break; }
            if (!ids.length) { if (names[0]) unmatched.add(`aa:${names[0]}`); continue; }
            await recordTaskScore(pool, ids[0], {
              taskType, score: clamp01(v / top), source: 'leaderboard_aa',
              evidence: `https://artificialanalysis.ai/ — Artificial Analysis ${field.replace('artificial_analysis_', '')} ${v} (top ${top})`,
            });
            summary.aa.written++; matchedAa.add(ids[0]);
          }
        }
        summary.aa.matchedCanonicals = matchedAa.size;
        log(`aa: ${rows.length} models, ${matchedAa.size} matched canonicals, ${summary.aa.written} scores`);
      } catch (e: any) { summary.aa.err = e?.message ?? String(e); log(`aa: ${summary.aa.err}`); }
    }

    summary.unmatchedSample = [...unmatched].slice(0, 25);
    summary.finishedAt = new Date().toISOString();
    log(`done: arena ${summary.arena.written} scores over ${summary.arena.matchedCanonicals} canonicals; aa ${summary.aa.written}; unmatched board names: ${unmatched.size}`);
    return summary;
  } catch (err: any) {
    summary.note = `error: ${err?.message ?? err}`;
    summary.finishedAt = new Date().toISOString();
    log(summary.note);
    return summary;
  } finally {
    running = false;
    // Stamp in the finally (both paths) — a guard keyed to a value the work can
    // withhold can't engage while the work is failing (catalogSync lesson, d950b1b).
    try {
      await run(pool, `INSERT INTO settings (key, value) VALUES ('leaderboard_sync_last_run', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [summary.finishedAt]);
      await run(pool, `INSERT INTO settings (key, value) VALUES ('leaderboard_sync_last_summary', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(summary)]);
    } catch (e: any) { log(`WARN: failed to persist last_run/summary: ${e?.message ?? e}`); }
  }
}

export async function getLastLeaderboardStatus(pool: pg.Pool): Promise<{ lastRun: string | null; summary: LeaderboardSyncSummary | null }> {
  const runRow = await get<{ value: string }>(pool, `SELECT value FROM settings WHERE key = 'leaderboard_sync_last_run'`);
  const sumRow = await get<{ value: string }>(pool, `SELECT value FROM settings WHERE key = 'leaderboard_sync_last_summary'`);
  let summary: LeaderboardSyncSummary | null = null;
  if (sumRow?.value) { try { summary = JSON.parse(sumRow.value); } catch { summary = null; } }
  return { lastRun: runRow?.value ?? null, summary };
}
