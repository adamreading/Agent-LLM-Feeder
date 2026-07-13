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
const MATH_SYMBOLS = /√|∫|∑|∏|≥|≤|≠|\^\d|\bx\s*[\^]|\d+\s*[+\-*/×÷]\s*\d+|\d+\s*%\b|=\s*\?/;
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
  // Math: explicit math vocabulary OR arithmetic symbol patterns.
  if (MATH_ASKS.test(t) || MATH_SYMBOLS.test(t)) {
    return { taskClass: 'math', confidence: 'high', structuralNeeds, reason: 'math vocabulary / arithmetic symbols' };
  }
  // Creative generation.
  if (CREATIVE_ASKS.test(t)) {
    return { taskClass: 'creative', confidence: 'high', structuralNeeds, reason: 'creative-writing ask' };
  }
  // Weaker code hints (syntax tokens without an explicit ask) — medium.
  if (CODE_HINTS.test(t)) {
    return { taskClass: 'coding', confidence: 'medium', structuralNeeds, reason: 'code-like tokens present' };
  }
  // Reasoning / explanation.
  if (REASONING_ASKS.test(t)) {
    return { taskClass: 'reasoning', confidence: 'medium', structuralNeeds, reason: 'reasoning/explanation ask' };
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
