// Tier-0 prompt classifier — pure, ~0ms, dependency-free heuristics that turn a
// prompt into a routing `task_class` (which the router maps via taskTypeFor to a
// task_type it holds quality scores for). This is the fix for "the black hole":
// the router is already task-aware (task_scores is its dominant ordering term)
// but was starved because nothing classified the prompt — callers sent a fixed
// class or nothing, so coding/math/reasoning/creative scores were never selected.
//
// Design rules (council-ratified 2026-07-13):
// - CALLER-AGNOSTIC: reads only the prompt text + already-known structural facts.
//   Any OpenAI-compatible client benefits; no consumer-specific knowledge.
// - task_class is ORDERING ONLY. It NEVER becomes a capability need. `needs[]`
//   (tools/json_mode/vision/...) remains a separate HARD filter (Lunk's caveat:
//   a "trivial"-looking turn may still fire a tool → must stay eligible).
// - Runs on the LATEST user turn only (per-turn re-classification, D2).
// - Returns a confidence so tier-1 (a small local model) can be invoked only for
//   the genuinely ambiguous residue, later, without changing this contract.
//
// Output task_class values are ones router.ts TASK_CLASS_TO_TASK_TYPE understands
// (coding/math/reasoning/creative/long_context/multi_turn) or null (→ 'overall').

export type Tier0Confidence = 'high' | 'medium' | 'low';

export interface Tier0Result {
  /** task_class for routing ORDER, or null → router uses 'overall'. */
  taskClass: string | null;
  confidence: Tier0Confidence;
  /** structural capability needs derived from content (HARD filter, merged by caller). */
  structuralNeeds: string[];
  /** why — for observability / debugging. */
  reason: string;
}

const LONG_CONTEXT_TOKENS = 32000; // long-query territory; router still derives its own ctx filter

// Distinctive, low-false-positive signals first. Order = precedence.
const CODE_FENCE = /```|~~~/;
const CODE_HINTS = /\b(def |function |class |import |const |let |var |public |private |return |async |await|=>|console\.|System\.|printf|std::|#include|npm |pip |git |SELECT .*FROM|CREATE TABLE|<\/?[a-z]+>)/;
const CODE_ASKS = /\b(refactor|debug|stack ?trace|traceback|compile|syntax error|null ?pointer|segfault|unit test|regex|write (a |an )?(function|script|program|class|method|query|component|api)|fix (this|the|my) (code|bug|function)|implement (a|an|the)|code review)\b/i;
const MATH_ASKS = /\b(integral|derivative|differentiate|integrate|equation|factorial|logarithm|matrix|probability|permutation|standard deviation|solve for|evaluate|simplify|square root|\bsqrt\b|modulo|prime factor)\b/i;
// Arithmetic-symbol signal. Deliberately PRECISE to avoid stamping prose as math
// (Adam-flagged FP 2026-07-14: reasoning turns citing a ratio/date got 'math').
//  - +, *, ×, ÷ are unambiguous → allowed tight ("5*3", "5 * 3").
//  - - and / appear constantly in NON-math prose (dates 2023-2024, ratios 24/7,
//    hours 9-5, versions 3.2/4.0), so they require WHITESPACE BOTH SIDES ("5 - 3",
//    "10 / 2") — which real arithmetic has and dates/ratios/versions don't.
//  - Dropped the old `\d+%` alt: `%\b` never fired on prose percentages ("140%")
//    anyway (verified), and a percentage in a sentence isn't a math task.
const MATH_SYMBOLS = /√|∫|∑|∏|≥|≤|≠|\^\d|\bx\s*\^|\d+\s*[+*×÷]\s*\d+|\d+\s+[-/]\s+\d+|=\s*\?/;
const REASONING_ASKS = /\b(why |explain|prove|proof|step by step|reason(ing)?|logic|puzzle|deduce|infer|analy[sz]e|compare and contrast|walk me through|how does .* work|what causes|justify|trade-?offs?)\b/i;
const CREATIVE_ASKS = /\b(write (a |an )?(poem|story|haiku|sonnet|song|lyric|essay|tagline|slogan|joke|limerick|screenplay|dialogue|narrative)|compose|brainstorm|imagine (a|an|that)|come up with (a|an|some)|creative|rewrite .* in the style)\b/i;
const GREETING = /^(hi|hey|hello|yo|sup|thanks|thank you|thx|ok|okay|cool|nice|great|lol|good (morning|afternoon|evening|night))\b/i;

/** Extract the latest user message text (the turn we route THIS request for). */
export function latestUserText(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  // multimodal content array (vision) — flatten any text parts
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && Array.isArray(m.content)) {
      return (m.content as Array<{ type?: string; text?: string }>)
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text).join(' ');
    }
  }
  return '';
}

/** True if any user turn carries an image content part (OpenAI multimodal wire
 * format). Drives the `vision` structural need — a HARD capability floor, so it's
 * derived directly from content and merged into needs[] regardless of task_class. */
export function hasImageContent(messages: Array<{ role: string; content: unknown }>): boolean {
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const part of m.content as Array<{ type?: string }>) {
      if (part?.type === 'image_url') return true;
    }
  }
  return false;
}

export interface Tier0Ctx {
  estimatedTokens?: number;
  hasImage?: boolean;       // multimodal image part present
  hasHistory?: boolean;     // prior assistant turn exists (multi-turn conversation)
}

export function classifyTier0(text: string, ctx: Tier0Ctx = {}): Tier0Result {
  const structuralNeeds: string[] = [];
  if (ctx.hasImage) structuralNeeds.push('vision');
  if ((ctx.estimatedTokens ?? 0) >= LONG_CONTEXT_TOKENS) structuralNeeds.push('long_context');

  const t = (text ?? '').trim();
  const words = t ? t.split(/\s+/).length : 0;

  // Image present with little/no text → a vision task; task_class stays generic
  // (vision is a NEED, ordering by 'overall' among vision-capable models).
  if (ctx.hasImage && words < 8) {
    return { taskClass: null, confidence: 'high', structuralNeeds, reason: 'image with minimal text → vision need, overall ordering' };
  }

  // Strong structural: fenced code is almost always a coding task.
  if (CODE_FENCE.test(t) || CODE_ASKS.test(t)) {
    return { taskClass: 'coding', confidence: 'high', structuralNeeds, reason: 'code fence / explicit code ask' };
  }
  // Math VOCABULARY (integral/derivative/solve for/…) is an unambiguous math
  // signal → high, checked early. Bare arithmetic SYMBOLS are checked LATER
  // (after reasoning) so a "why … 24/7 …" reasoning turn isn't hijacked to math
  // by an incidental number pattern (Adam-flagged FP 2026-07-14).
  if (MATH_ASKS.test(t)) {
    return { taskClass: 'math', confidence: 'high', structuralNeeds, reason: 'math vocabulary' };
  }
  // Creative generation.
  if (CREATIVE_ASKS.test(t)) {
    return { taskClass: 'creative', confidence: 'high', structuralNeeds, reason: 'creative-writing ask' };
  }
  // Weaker code hints (syntax tokens without an explicit ask) — medium.
  if (CODE_HINTS.test(t)) {
    return { taskClass: 'coding', confidence: 'medium', structuralNeeds, reason: 'code-like tokens present' };
  }
  // Reasoning / explanation — checked BEFORE bare math symbols so an analytical
  // turn ("why …", "explain …") that merely cites a number/ratio/date routes as
  // reasoning, not math.
  if (REASONING_ASKS.test(t)) {
    return { taskClass: 'reasoning', confidence: 'medium', structuralNeeds, reason: 'reasoning/explanation ask' };
  }
  // Bare arithmetic symbols with no reasoning framing → an actual math task
  // (e.g. "5 * 27 - 12", "∫x dx", "3 ≥ 2"). Precise pattern (see MATH_SYMBOLS).
  if (MATH_SYMBOLS.test(t)) {
    return { taskClass: 'math', confidence: 'high', structuralNeeds, reason: 'arithmetic symbols (no reasoning framing)' };
  }
  // Long input with no stronger signal → long-context handling.
  if ((ctx.estimatedTokens ?? 0) >= LONG_CONTEXT_TOKENS) {
    return { taskClass: 'long_context', confidence: 'medium', structuralNeeds, reason: 'very long input' };
  }
  // Trivial: a short greeting/ack with no history and no other signal.
  if (words > 0 && words <= 4 && GREETING.test(t) && !ctx.hasHistory) {
    return { taskClass: 'trivial', confidence: 'high', structuralNeeds, reason: 'short greeting/ack' };
  }
  // Nothing distinctive → generic. LOW confidence flags this for optional tier-1.
  return { taskClass: null, confidence: 'low', structuralNeeds, reason: 'no distinctive signal → overall (tier-1 candidate)' };
}

// ── Tier-1: a tiny LOCAL Ollama classifier for the low-confidence residue ────
// Gated OFF unless CLASSIFIER_OLLAMA_URL is set (default: disabled → tier-0 only,
// zero external dependency, zero voice-box contention). When enabled it calls a
// FIXED small model DIRECTLY over HTTP (never through routeRequest), reasoning
// OFF, with a TIGHT timeout — any timeout/error/miss falls back to tier-0's
// result, so it can never block or break a request. Model default llama3.2:3b
// passed the Phase-1 gate (14/14 acc, ~1.3s cold / ~257ms warm).
//
// Shared-Ollama safety: on the 5090 the feeder locally loads ONLY this tiny model
// (llama3.2:3b). OB has NO standing gemma worker (entity worker retired; Plaud
// curation is Lunk-primary, gemma not consulted) and Hermes voice (qwen3.5:4b)
// runs on-demand.
//
// tier-1 runs ON-DEMAND too (Adam's direct call, 2026-07-13): load for the
// classify, then drop RIGHT AFTER — no persistent ~11GB footprint sitting on the
// 5090 between classifies. keep_alive=0 unloads immediately; num_ctx is capped
// LOW (the classifier only ever sees a short system prompt + a truncated user
// turn) which shrinks the KV-cache — an uncapped 3B was holding ~11GB, almost all
// KV. Endpoint is the NATIVE /api/chat, NOT Ollama's OpenAI-compat /v1 (which
// SILENTLY IGNORES both keep_alive and num_ctx — wsl's hard-won finding), so both
// take effect. That host Ollama is windows-claude's lane; until CLASSIFIER_OLLAMA_URL
// is configured, tier-1 stays off.
const TIER1_URL = process.env.CLASSIFIER_OLLAMA_URL || '';
const TIER1_MODEL = process.env.CLASSIFIER_MODEL || 'llama3.2:3b';
// 2500ms default: a COLD model load is ~1.9-2.1s and with keep_alive=0 EVERY
// classify is cold (the accepted trade-off for zero idle VRAM). This ceiling lets
// a cold classify usually still complete; if it doesn't, we fall back to tier-0.
const TIER1_TIMEOUT_MS = Number(process.env.CLASSIFIER_TIMEOUT_MS) || 2500;
// '0' = unload immediately after the classify (on-demand, Adam's call). Override
// with CLASSIFIER_KEEP_ALIVE (e.g. '10s') to trade a little idle VRAM for fewer
// cold loads on bursty traffic.
const TIER1_KEEP_ALIVE = process.env.CLASSIFIER_KEEP_ALIVE || '0';
// Small context cap — the classifier's whole input is a short few-shot system
// prompt + one truncated user turn, so it never needs a big window. Slashes the
// KV-cache footprint during the brief load. Honored because we use /api/chat.
const TIER1_NUM_CTX = Number(process.env.CLASSIFIER_NUM_CTX) || 2048;

export function tier1Enabled(): boolean { return !!TIER1_URL; }

const TIER1_LABELS = ['coding', 'math', 'reasoning', 'creative', 'trivial', 'general'];
const TIER1_SYS = `You label a user prompt with ONE routing category. Output ONLY the single category word, nothing else.
Categories: coding, math, reasoning, creative, trivial, general.
Examples:
"Write a Python function to reverse a list" -> coding
"What is the integral of x^2 dx" -> math
"Prove sqrt(2) is irrational, step by step" -> reasoning
"Write a short poem about autumn" -> creative
"hi" -> trivial
"Summarize the French Revolution" -> general`;

// Returns a task_class string, or null on timeout/error/unmapped (caller keeps
// its tier-0 result). Never throws.
export async function classifyTier1(text: string): Promise<string | null> {
  if (!TIER1_URL || !text.trim()) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIER1_TIMEOUT_MS);
  try {
    const res = await fetch(`${TIER1_URL.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TIER1_MODEL,
        messages: [{ role: 'system', content: TIER1_SYS }, { role: 'user', content: `"${text.slice(0, 2000)}" ->` }],
        stream: false, think: false, keep_alive: TIER1_KEEP_ALIVE,
        options: { temperature: 0, num_predict: 4, num_ctx: TIER1_NUM_CTX },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = await res.json() as { message?: { content?: string } };
    const raw = (body.message?.content || '').toLowerCase();
    const label = TIER1_LABELS.find((l) => raw.includes(l));
    // 'trivial'/'general' -> null (router's 'overall'); the rest are real task_classes.
    if (!label || label === 'trivial' || label === 'general') return null;
    return label;
  } catch {
    return null; // timeout / network / parse — degrade to tier-0
  } finally {
    clearTimeout(timer);
  }
}

// Full classification: tier-0 always; tier-1 ONLY for the low-confidence residue,
// and only when enabled AND the caller's latency budget can absorb it. Structural
// needs always come from tier-0 (deterministic). Never throws.
export async function classifyPrompt(
  text: string,
  ctx: Tier0Ctx & { latencyCeilingMs?: number | null } = {},
): Promise<Tier0Result & { tier: 0 | 1 }> {
  const t0 = classifyTier0(text, ctx);
  const budgetOk = ctx.latencyCeilingMs == null || ctx.latencyCeilingMs >= TIER1_TIMEOUT_MS + 1000;
  if (t0.confidence !== 'low' || !tier1Enabled() || !budgetOk) return { ...t0, tier: 0 };
  const t1 = await classifyTier1(text);
  if (t1) return { taskClass: t1, confidence: 'medium', structuralNeeds: t0.structuralNeeds, reason: `tier-1 (${TIER1_MODEL})`, tier: 1 };
  return { ...t0, tier: 0 };
}
