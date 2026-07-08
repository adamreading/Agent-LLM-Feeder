import type { ProbeContext, ProbeOutcome } from './runner.js';
import { logProbeRequest } from './runner.js';

// A probe call failed for a reason unrelated to the model's actual
// capability (rate limit, transport timeout, upstream 5xx) — recording a
// false negative here would poison measured data with an infra artifact
// indistinguishable from "genuinely doesn't support this."
function isTransientError(message: string): boolean {
  return /429|rate.?limit|too many requests|timeout|aborted|ECONNRESET|ETIMEDOUT|5\d\d\b/i.test(message);
}

// --- tools -------------------------------------------------------------
// Offer a function, assert a REAL tool_calls response comes back with the
// right function name — not just "the call didn't error."
export async function probeTools(ctx: ProbeContext): Promise<ProbeOutcome> {
  const start = Date.now();
  try {
    const result = await ctx.provider.chatCompletion(ctx.apiKey, [
      { role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' },
    ], ctx.modelId, {
      max_tokens: 100,
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      }],
      tool_choice: 'required',
    });
    const latencyMs = Date.now() - start;
    void logProbeRequest(ctx.platform, ctx.modelId, 'success', result.usage?.prompt_tokens ?? 0, result.usage?.completion_tokens ?? 0, latencyMs, null);
    const call = result.choices?.[0]?.message?.tool_calls?.[0];
    const passed = call?.function?.name === 'get_weather';
    return {
      passed,
      latencyMs,
      evidence: passed
        ? `tool_calls returned: ${JSON.stringify(call)}`
        : `no valid get_weather tool_call in response: ${JSON.stringify(result.choices?.[0]?.message)}`,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    void logProbeRequest(ctx.platform, ctx.modelId, 'error', 0, 0, latencyMs, err.message);
    return {
      passed: false,
      latencyMs,
      evidence: `error: ${err.message}`,
      transient: isTransientError(err.message ?? ''),
    };
  }
}

// --- json_mode -----------------------------------------------------------
// ob-claude's review: assert VALID JSON PARSEABLE AGAINST A MINIMAL SCHEMA,
// never just "the call didn't error." A model can accept response_format
// and ignore it, returning prose with a clean 200 — that must fail the probe.
export async function probeJsonMode(ctx: ProbeContext): Promise<ProbeOutcome> {
  const start = Date.now();
  try {
    const result = await ctx.provider.chatCompletion(ctx.apiKey, [
      { role: 'user', content: 'Reply with ONLY a JSON object of the exact shape {"answer": 42}. No other text.' },
    ], ctx.modelId, {
      max_tokens: 50,
      response_format: { type: 'json_object' },
    });
    const latencyMs = Date.now() - start;
    void logProbeRequest(ctx.platform, ctx.modelId, 'success', result.usage?.prompt_tokens ?? 0, result.usage?.completion_tokens ?? 0, latencyMs, null);
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return { passed: false, latencyMs, evidence: 'no string content in response' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { passed: false, latencyMs, evidence: `not valid JSON: ${content.slice(0, 200)}` };
    }
    const passed = typeof parsed === 'object' && parsed !== null && typeof (parsed as any).answer === 'number';
    return {
      passed,
      latencyMs,
      evidence: passed ? `parsed correctly: ${content.slice(0, 100)}` : `wrong shape: ${content.slice(0, 200)}`,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    void logProbeRequest(ctx.platform, ctx.modelId, 'error', 0, 0, latencyMs, err.message);
    return {
      passed: false,
      latencyMs,
      evidence: `error: ${err.message}`,
      transient: isTransientError(err.message ?? ''),
    };
  }
}

// --- reasoning_control ---------------------------------------------------
// wsl-claude's method: where response inspection is unreliable (some models
// don't surface a reasoning field), use LATENCY DELTA as the signal.
// Requires the caller to pass the provider's confirmed dialect explicitly —
// this probe VERIFIES a claimed dialect, it doesn't guess one.
export async function probeReasoningControl(
  ctx: ProbeContext,
  dialect: 'openai_reasoning_effort' | 'nested_reasoning_effort' | 'chat_template_enable_thinking',
): Promise<ProbeOutcome> {
  const prompt = 'Solve this step by step: if a train travels 240 miles in 4 hours, then speeds up by 25% for the next 2 hours, how far does it travel in total?';
  try {
    const baselineStart = Date.now();
    const baselineResult = await ctx.provider.chatCompletion(ctx.apiKey, [{ role: 'user', content: prompt }], ctx.modelId, { max_tokens: 300 });
    const baselineLatency = Date.now() - baselineStart;
    void logProbeRequest(ctx.platform, ctx.modelId, 'success', baselineResult.usage?.prompt_tokens ?? 0, baselineResult.usage?.completion_tokens ?? 0, baselineLatency, null);

    const testStart = Date.now();
    const testResult = await ctx.provider.chatCompletion(ctx.apiKey, [{ role: 'user', content: prompt }], ctx.modelId, {
      max_tokens: 300,
      reasoning_effort: 'none',
    });
    const testLatency = Date.now() - testStart;
    void logProbeRequest(ctx.platform, ctx.modelId, 'success', testResult.usage?.prompt_tokens ?? 0, testResult.usage?.completion_tokens ?? 0, testLatency, null);

    // wsl's live data: right dialect ~10x faster (2.1s vs 21.1s). Require a
    // clear majority reduction, not just "slightly faster" (noise-prone).
    const passed = testLatency < baselineLatency * 0.5;
    return {
      passed,
      latencyMs: testLatency,
      evidence: `baseline=${baselineLatency}ms reasoning_effort:none=${testLatency}ms (ratio=${(testLatency / baselineLatency).toFixed(2)})`,
      dialect,
    };
  } catch (err: any) {
    void logProbeRequest(ctx.platform, ctx.modelId, 'error', 0, 0, 0, err.message);
    return { passed: false, latencyMs: 0, evidence: `error: ${err.message}`, dialect, transient: isTransientError(err.message ?? '') };
  }
}

// --- long_context (needle-recall) ----------------------------------------
// ob-claude's generalization of wsl's ctx-needle probe: a declared
// context_window is a spec-sheet claim exactly like json_mode — only a
// needle-recall test proves the serving stack isn't silently
// summarizing/truncating/dropping the middle. EXPENSIVE (large prompt) —
// callers should run this sparingly, not on every routine probe pass.
export async function probeLongContext(ctx: ProbeContext, targetTokens: number): Promise<ProbeOutcome> {
  const marker = `NEEDLE-${Math.random().toString(36).slice(2, 10)}`;
  const fillerSentence = 'The quick brown fox jumps over the lazy dog in the meadow. ';
  const fillerTokensPerSentence = 12; // ~4 chars/token heuristic
  const sentencesNeeded = Math.ceil((targetTokens - 50) / fillerTokensPerSentence);
  const filler = fillerSentence.repeat(Math.max(1, sentencesNeeded));

  const prompt = `The secret code is ${marker}. Remember it.\n\n${filler}\n\nWhat was the secret code mentioned at the start of this message?`;

  const start = Date.now();
  try {
    const result = await ctx.provider.chatCompletion(ctx.apiKey, [{ role: 'user', content: prompt }], ctx.modelId, {
      max_tokens: 50,
    });
    const latencyMs = Date.now() - start;
    void logProbeRequest(ctx.platform, ctx.modelId, 'success', result.usage?.prompt_tokens ?? 0, result.usage?.completion_tokens ?? 0, latencyMs, null);
    const content = result.choices?.[0]?.message?.content ?? '';
    const passed = content.includes(marker);
    return {
      passed,
      latencyMs,
      evidence: passed
        ? `recalled marker correctly at ~${targetTokens} estimated tokens`
        : `marker NOT recalled — response: ${content.slice(0, 200)}`,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    void logProbeRequest(ctx.platform, ctx.modelId, 'error', 0, 0, latencyMs, err.message);
    return {
      passed: false,
      latencyMs,
      evidence: `error: ${err.message}`,
      transient: isTransientError(err.message ?? ''),
    };
  }
}
