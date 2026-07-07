import type { ProbeContext, ProbeOutcome } from './runner.js';

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
    return {
      passed: false,
      latencyMs: Date.now() - start,
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
    return {
      passed: false,
      latencyMs: Date.now() - start,
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
    await ctx.provider.chatCompletion(ctx.apiKey, [{ role: 'user', content: prompt }], ctx.modelId, { max_tokens: 300 });
    const baselineLatency = Date.now() - baselineStart;

    const testStart = Date.now();
    await ctx.provider.chatCompletion(ctx.apiKey, [{ role: 'user', content: prompt }], ctx.modelId, {
      max_tokens: 300,
      reasoning_effort: 'none',
    });
    const testLatency = Date.now() - testStart;

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
    return {
      passed: false,
      latencyMs: Date.now() - start,
      evidence: `error: ${err.message}`,
      transient: isTransientError(err.message ?? ''),
    };
  }
}

// --- ob_readwrite (Adam's minimum bar for main-brain eligibility) --------
// Generic tool-calling isn't enough — a model must actually drive Lunk's
// real Open Brain read/write tools, mirroring the EXACT schemas Hermes
// registers (wsl-claude, 2026-07-07) so a pass proves the real tools work,
// not an approximation of them. ob_readwrite=true only if BOTH the read and
// write probes pass — a model that reads fine but mangles write args is not
// eligible (windows-claude's framing). Each probe executes the tool call
// FOR REAL against Open Brain's REST API (not just checking the model's
// tool_call shape) — a well-formed call that the real endpoint rejects, or
// whose effect can't be verified, is not a pass.

export interface ObConfig {
  // wsl-claude, 2026-07-07: SUPABASE_URL + '/functions/v1/rest-api' — the
  // same rest-api feeder already hits for the Open Engine work-queue.
  baseUrl: string;
  // Header IS "x-brain-key", not "Authorization: Bearer" — confirmed
  // MCP_ACCESS_KEY == Hermes's OPENBRAIN_KEY (identical value).
  authHeader: Record<string, string>;
  // Path segment for the real ajo_search backing endpoint — still
  // unconfirmed (windows-claude owns rest-api, hasn't posted it yet as of
  // 2026-07-07 22:00). Left required-but-unset rather than guessed so a
  // misconfiguration fails loudly instead of silently hitting a wrong route.
  searchPath: string;
  // Content of a PERMANENT fixture thought seeded once via POST /capture
  // (not /capture-pending) — durable so read-probes never race the
  // pending-review/embedding-indexing gate. windows-claude seeds this.
  readFixtureMarker: string;
}

const AJO_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'ajo_search',
    description: "Semantic search across AJO's personal Open Brain thoughts/notes. READ-ONLY.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in AJO\'s brain.' },
        limit: { type: 'integer', default: 10 },
        classification: { type: 'string', enum: ['work', 'personal'] },
      },
      required: ['query'],
    },
  },
};

const AJO_CAPTURE_PENDING_TOOL = {
  type: 'function' as const,
  function: {
    name: 'ajo_capture_pending',
    description: 'GATED write: create a pending-review thought (intake-curator output). Lands in /review for human approval.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        type: { type: 'string' },
        classification: { type: 'string', enum: ['work', 'personal'] },
        metadata: { type: 'object' },
        source_type: { type: 'string' },
        dry_run: { type: 'boolean' },
        idempotency_key: { type: 'string' },
      },
      required: ['content'],
    },
  },
};

export async function probeObRead(ctx: ProbeContext, ob: ObConfig): Promise<ProbeOutcome> {
  const start = Date.now();
  try {
    const result = await ctx.provider.chatCompletion(ctx.apiKey, [
      { role: 'user', content: `Search Open Brain for "${ob.readFixtureMarker}" and tell me what you find.` },
    ], ctx.modelId, {
      max_tokens: 100,
      tools: [AJO_SEARCH_TOOL],
      tool_choice: 'required',
    });
    const call = result.choices?.[0]?.message?.tool_calls?.[0];
    if (call?.function?.name !== 'ajo_search') {
      return { passed: false, latencyMs: Date.now() - start, evidence: `no ajo_search tool_call: ${JSON.stringify(result.choices?.[0]?.message)}` };
    }
    let args: { query?: string };
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      return { passed: false, latencyMs: Date.now() - start, evidence: `ajo_search args not valid JSON: ${call.function.arguments}` };
    }
    if (!args.query) {
      return { passed: false, latencyMs: Date.now() - start, evidence: `ajo_search called with no query: ${call.function.arguments}` };
    }

    // Execute the tool call FOR REAL against Open Brain — a well-formed
    // call that doesn't actually round-trip is not a pass. windows-claude,
    // 2026-07-07: mode=text not the default semantic search — a random hex
    // marker has no semantic content, embedding similarity isn't guaranteed
    // to surface it above threshold; text mode does a literal match, which
    // is what a probe marker actually needs.
    const searchUrl = `${ob.baseUrl}${ob.searchPath}?q=${encodeURIComponent(args.query)}&mode=text`;
    const searchRes = await fetch(searchUrl, { headers: ob.authHeader });
    const latencyMs = Date.now() - start;
    if (!searchRes.ok) {
      const isServerSide = searchRes.status >= 500 || searchRes.status === 429;
      return { passed: false, latencyMs, evidence: `OB ${ob.searchPath} HTTP ${searchRes.status}`, transient: isServerSide };
    }
    const body = await searchRes.json();
    const resultsText = JSON.stringify(body);
    const passed = resultsText.includes(ob.readFixtureMarker);
    return {
      passed,
      latencyMs,
      evidence: passed
        ? `ajo_search(${JSON.stringify(args)}) round-tripped the fixture marker`
        : `ajo_search(${JSON.stringify(args)}) executed but fixture marker not in results: ${resultsText.slice(0, 200)}`,
    };
  } catch (err: any) {
    return { passed: false, latencyMs: Date.now() - start, evidence: `error: ${err.message}`, transient: isTransientError(err.message ?? '') };
  }
}

export async function probeObWrite(ctx: ProbeContext, ob: ObConfig, runId: string): Promise<ProbeOutcome> {
  const start = Date.now();
  const marker = `[OB-PROBE-${runId}]`;
  const testSentence = `${marker} capability-probe write, safe to dismiss from /review.`;
  try {
    const result = await ctx.provider.chatCompletion(ctx.apiKey, [
      { role: 'user', content: `Record this in Open Brain: ${testSentence}` },
    ], ctx.modelId, {
      max_tokens: 150,
      tools: [AJO_CAPTURE_PENDING_TOOL],
      tool_choice: 'required',
    });
    const call = result.choices?.[0]?.message?.tool_calls?.[0];
    if (call?.function?.name !== 'ajo_capture_pending') {
      return { passed: false, latencyMs: Date.now() - start, evidence: `no ajo_capture_pending tool_call: ${JSON.stringify(result.choices?.[0]?.message)}` };
    }
    let args: { content?: string };
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      return { passed: false, latencyMs: Date.now() - start, evidence: `ajo_capture_pending args not valid JSON: ${call.function.arguments}` };
    }
    if (!args.content || !args.content.includes(marker)) {
      return { passed: false, latencyMs: Date.now() - start, evidence: `ajo_capture_pending content missing marker: ${call.function.arguments}` };
    }

    const captureRes = await fetch(`${ob.baseUrl}/capture-pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ob.authHeader },
      body: JSON.stringify({ content: args.content, source_type: 'probe', idempotency_key: runId }),
    });
    if (!captureRes.ok) {
      const isServerSide = captureRes.status >= 500 || captureRes.status === 429;
      return { passed: false, latencyMs: Date.now() - start, evidence: `OB /capture-pending HTTP ${captureRes.status}`, transient: isServerSide };
    }

    // Verify the write actually landed, not just that the endpoint 200'd.
    // wsl-claude, 2026-07-07: GET /thoughts?review_status=pending_review is
    // the real pending-review queue (NOT /review?status=... — different path
    // and query param name than an earlier draft of this probe assumed).
    const reviewRes = await fetch(`${ob.baseUrl}/thoughts?review_status=pending_review`, { headers: ob.authHeader });
    const latencyMs = Date.now() - start;
    if (!reviewRes.ok) {
      return { passed: false, latencyMs, evidence: `OB /thoughts?review_status=pending_review HTTP ${reviewRes.status}`, transient: reviewRes.status >= 500 };
    }
    const reviewBody = await reviewRes.json();
    const landedRow = findRowContaining(reviewBody, marker);
    const landed = landedRow != null;

    // Best-effort cleanup — DELETE /thought/:id (windows-claude, 2026-07-07).
    // Never lets a cleanup failure flip a real pass into a probe failure;
    // source_type:'probe' also keeps these out of Adam's real curation queue
    // even if cleanup doesn't fire, per windows' original spec.
    if (landedRow?.id != null) {
      try {
        await fetch(`${ob.baseUrl}/thought/${landedRow.id}`, { method: 'DELETE', headers: ob.authHeader });
      } catch {
        // non-fatal — leaves a source_type:'probe' row for manual cleanup
      }
    }

    return {
      passed: landed,
      latencyMs,
      evidence: landed
        ? `write landed in pending_review queue with marker ${marker}${landedRow?.id != null ? ` (cleaned up id ${landedRow.id})` : ' (id not found, skipped cleanup)'}`
        : `capture-pending 200'd but marker not found in pending-review queue`,
    };
  } catch (err: any) {
    return { passed: false, latencyMs: Date.now() - start, evidence: `error: ${err.message}`, transient: isTransientError(err.message ?? '') };
  }
}

// Best-effort: find the list entry containing `marker` and pull a plausible
// id field from it. Response shape isn't fully confirmed, so this degrades
// gracefully (returns null) rather than throwing on an unexpected shape —
// cleanup is a courtesy, not something a probe's pass/fail should hinge on.
function findRowContaining(body: unknown, marker: string): { id: string | number } | null {
  const rows: unknown[] = Array.isArray(body) ? body : Array.isArray((body as any)?.thoughts) ? (body as any).thoughts : Array.isArray((body as any)?.data) ? (body as any).data : [];
  for (const row of rows) {
    if (typeof row === 'object' && row !== null && JSON.stringify(row).includes(marker)) {
      const id = (row as any).id ?? (row as any).thought_id ?? (row as any).uuid;
      if (id != null) return { id };
    }
  }
  return null;
}
