// Phase 4 — web-search auto-augment. When a caller OPTS IN (augment: 'auto' or
// 'force'), the feeder can run the Onboarding-configured search backend (Tavily/
// DDG/Ollama, via webSearch.ts) and inject the results as grounding context
// before routing to a text model — so a bare-`auto` question about current events
// gets a fresh answer without the caller wiring its own search tool.
//
// PROVENANCE CARVE-OUT (OB's hard requirement, council-ratified): this is OPT-IN.
// Default policy is 'off' (see proxy.ts) — a request is NEVER augmented unless it
// explicitly asks. OB's grounded/closed-world jobs (entity extraction, wiki
// compile, plaud-curator) simply never set the field, so their prompts are never
// silently contaminated with web content. `off` is the carve-out.
//
// Degrade-safe everywhere: no config, no results, timeout, or any error → returns
// null and the request proceeds UNAUGMENTED. Augmentation must never block or
// fail a completion.

import { getSearchBackend } from './webSearch.js';

export type AugmentPolicy = 'off' | 'auto' | 'force';

export function parseAugmentPolicy(raw: unknown): AugmentPolicy {
  return raw === 'auto' || raw === 'force' ? raw : 'off';
}

// Global DEFAULT policy for requests that don't set the field (Adam, 2026-07-13:
// "default off, but .env override"). Env-driven so an operator can flip the whole
// fleet to opt-OUT behaviour live (FEEDER_AUGMENT_DEFAULT=auto) without a code
// change — a per-request `augment` field still overrides this either way.
// Restricted to off|auto: a global 'force' (search literally every request) is
// never what you want, so anything but 'auto' resolves to 'off'.
export function augmentDefault(): AugmentPolicy {
  return process.env.FEEDER_AUGMENT_DEFAULT === 'auto' ? 'auto' : 'off';
}

// HARD server-side augment block by consumer label (OB's P4b requirement,
// 2026-07-13). Defense-in-depth ON TOP OF default-off: a request from a blocked
// consumer is NEVER augmented, regardless of the augment field — so a future
// config/code slip that set augment:'auto' for a grounded worker still can't
// silently contaminate closed-world output (a corrupted wiki article / entity is
// silent + permanent). Default blocklist: 'open-brain' (OB's grounded workers);
// override/extend with AUGMENT_BLOCKED_CONSUMERS (comma-separated). If OB ever
// needs web-augmented generation it uses a DISTINCT label, so this loses nothing.
const AUGMENT_BLOCKED_CONSUMERS = new Set(
  (process.env.AUGMENT_BLOCKED_CONSUMERS || 'open-brain')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

export function isAugmentBlockedConsumer(consumer: string | null | undefined): boolean {
  return !!consumer && AUGMENT_BLOCKED_CONSUMERS.has(consumer.toLowerCase());
}

// Does this prompt likely need CURRENT / web-fresh info? Deliberately narrow —
// only fire on clear recency/lookup signals, since a false positive costs a
// search round-trip + injects noise. 'force' bypasses this; 'auto' gates on it.
const CURRENT_INFO = /\b(latest|current(ly)?|today|tonight|this (week|month|year)|right now|recent(ly)?|news|headlines?|202[4-9]|20[3-9]\d|who (won|is winning)|stock|share price|market cap|weather|forecast|released?|launch(ed|ing)?|announce(d|ment)?|as of|up[- ]to[- ]date|breaking|price of)\b/i;
const EXPLICIT_SEARCH = /\b(search (for|the web|online|it up)|look (it |this )?up|google (it|this)?|find out (the )?(latest|current|who|what|when)|what'?s (happening|new)|current events)\b/i;

export function needsWebSearch(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  return EXPLICIT_SEARCH.test(t) || CURRENT_INFO.test(t);
}

/** True when this policy + prompt should trigger a search. */
export function shouldAugment(policy: AugmentPolicy, text: string): boolean {
  if (policy === 'force') return true;
  if (policy === 'auto') return needsWebSearch(text);
  return false;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('augment search timeout')), ms)),
  ]);
}

// Run the configured search backend and format results as an injectable context
// block, or null if nothing usable. The block is explicitly LABELLED as external
// web content (not the user's words) so a model treats it as grounding, and so a
// human reading the transcript can see the provenance.
export async function runWebAugment(query: string, opts: { maxResults?: number; timeoutMs?: number } = {}): Promise<string | null> {
  const maxResults = opts.maxResults ?? 4;
  const timeoutMs = opts.timeoutMs ?? 4000;
  try {
    const backend = getSearchBackend();
    if (!backend.isConfigured()) return null;
    const results = await withTimeout(backend.search(query.slice(0, 400), maxResults), timeoutMs);
    if (!results || results.length === 0) return null;
    const body = results.slice(0, maxResults).map((r, i) =>
      `${i + 1}. ${r.title || r.url}\n   ${r.url}\n   ${(r.content || '').replace(/\s+/g, ' ').slice(0, 500)}`
    ).join('\n\n');
    return `[Feeder web-search context — live external web results retrieved to help answer the user's question. Prefer these over prior knowledge for current facts, and treat them as external sources (not the user's words). Cite the source URLs where relevant.]\n\n${body}`;
  } catch {
    return null; // no-config / timeout / network / parse — proceed unaugmented
  }
}
