// P3 research cron: weekly-cadence, web-search-driven discovery of DECLARED
// model capability facts (Adam's direct instruction: use Ollama's hosted
// web-search API — the same one Hermes uses — not a separate search-
// grounded model). Declared facts are leads for the probe bank, never
// trusted directly for hard safety gates (see router.ts's tools-gate
// comment) — they exist to widen coverage for scoring/ranking and to tell
// the probe scheduler what's worth verifying next.
import { getPool } from '../db/index.js';
import { get, run } from '../db/pgCompat.js';
import { getProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { webSearch, webFetch } from './ollamaSearch.js';
import { logProbeRequest } from './probes/runner.js';

export interface DeclaredFact {
  capability: 'tools' | 'json_mode' | 'vision' | 'reasoning_control';
  supported: boolean;
  evidence: string;
}

export interface ResearchOutcome {
  platform: string;
  modelId: string;
  facts: DeclaredFact[];
  sourcesUsed: string[];
}

const EXTRACTABLE_CAPABILITIES = ['tools', 'json_mode', 'vision', 'reasoning_control'] as const;

// Which real, feeder-keyed model does the extraction (structured-output
// step, not the search itself). Needs confirmed json_mode so the extraction
// step's own output is reliably parseable — using a MEASURED-confirmed
// model here, same trust bar as everywhere else tonight.
async function getExtractorContext(): Promise<{ platform: string; modelId: string; apiKey: string } | null> {
  const pool = getPool();
  const row = await get<{ platform: string; model_id: string; encrypted_key: string; iv: string; auth_tag: string }>(pool, `
    SELECT m.platform, m.model_id, k.encrypted_key, k.iv, k.auth_tag
    FROM model_capabilities mc
    JOIN models m ON m.id = mc.model_db_id
    JOIN api_keys k ON k.platform = m.platform AND k.enabled = true AND k.status != 'invalid'
    WHERE mc.capability = 'json_mode' AND mc.supported = true AND mc.source = 'measured'
    ORDER BY m.intelligence_rank ASC
    LIMIT 1
  `);
  if (!row) return null;
  return { platform: row.platform, modelId: row.model_id, apiKey: decrypt(row.encrypted_key, row.iv, row.auth_tag) };
}

// Research one model: search + fetch the most relevant result, then extract
// structured capability claims via a confirmed json_mode-capable model.
// Returns facts with `evidence` set to the source URL — never fabricated,
// never guessed for a capability the source text doesn't actually address
// (the extraction prompt explicitly requires null/omission over a guess).
export async function researchModel(platform: string, modelId: string): Promise<ResearchOutcome> {
  const extractor = await getExtractorContext();
  if (!extractor) {
    throw new Error('No measured json_mode-capable model available to run extraction — research cron needs at least one confirmed extractor.');
  }

  const query = `${platform} ${modelId} API model function calling tool use JSON mode vision context window capabilities`;
  const searchResults = await webSearch(query, 5);
  if (searchResults.length === 0) {
    return { platform, modelId, facts: [], sourcesUsed: [] };
  }

  // Fetch full content for the top result only — webFetch is a real network
  // call per URL, and search snippets are usually enough signal; fetching
  // everything would multiply API cost for marginal extra coverage.
  const topResult = searchResults[0];
  let fetchedContent = '';
  try {
    const fetched = await webFetch(topResult.url);
    fetchedContent = fetched.content;
  } catch {
    // Fall through to snippet-only extraction — a fetch failure on one URL
    // shouldn't sink the whole research pass for this model.
  }

  const corpus = [
    ...searchResults.map((r) => `[${r.url}]\n${r.title}\n${r.content}`),
    fetchedContent ? `[full fetch: ${topResult.url}]\n${fetchedContent.slice(0, 4000)}` : '',
  ].filter(Boolean).join('\n\n---\n\n');

  const provider = getProvider(extractor.platform as any);
  if (!provider) throw new Error(`Extractor platform ${extractor.platform} has no registered provider`);

  const extractionPrompt = `You are extracting FACTUAL capability claims about the LLM model "${platform}/${modelId}" from the search results below. For each of these capabilities, determine whether the source text EXPLICITLY states support or non-support: tools (function/tool calling), json_mode (JSON mode / structured output), vision (image input), reasoning_control (a toggle for extended thinking / reasoning effort).

Respond with ONLY a JSON object of this exact shape, using true/false only when the text explicitly addresses it, and OMITTING the key entirely when the text doesn't address it (do not guess):
{"tools": true|false, "json_mode": true|false, "vision": true|false, "reasoning_control": true|false}

Search results:
${corpus.slice(0, 12000)}`;

  const extractStart = Date.now();
  let result;
  try {
    result = await provider.chatCompletion(extractor.apiKey, [
      { role: 'user', content: extractionPrompt },
    ], extractor.modelId, {
      max_tokens: 200,
      response_format: { type: 'json_object' },
    });
    void logProbeRequest(extractor.platform, extractor.modelId, 'success', result.usage?.prompt_tokens ?? 0, result.usage?.completion_tokens ?? 0, Date.now() - extractStart, null);
  } catch (err: any) {
    void logProbeRequest(extractor.platform, extractor.modelId, 'error', 0, 0, Date.now() - extractStart, err.message);
    throw err;
  }

  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    return { platform, modelId, facts: [], sourcesUsed: searchResults.map((r) => r.url) };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { platform, modelId, facts: [], sourcesUsed: searchResults.map((r) => r.url) };
  }

  const facts: DeclaredFact[] = [];
  for (const capability of EXTRACTABLE_CAPABILITIES) {
    const value = parsed[capability];
    if (typeof value === 'boolean') {
      facts.push({ capability, supported: value, evidence: topResult.url });
    }
  }

  return { platform, modelId, facts, sourcesUsed: searchResults.map((r) => r.url) };
}

// Upsert declared facts into model_capabilities. Never touches a 'measured'
// row for the same (model, capability) — declared and measured coexist by
// design (schema's unique constraint is on model+capability+source), so
// this can never overwrite ground-truth probe data with a web-search claim.
export async function recordDeclaredFacts(modelDbId: number, outcome: ResearchOutcome): Promise<void> {
  const pool = getPool();
  for (const fact of outcome.facts) {
    await run(pool, `
      INSERT INTO model_capabilities (model_db_id, capability, supported, source, measured_at, evidence)
      VALUES (?, ?, ?, 'declared', now(), ?)
      ON CONFLICT (model_db_id, capability, source)
      DO UPDATE SET supported = EXCLUDED.supported, measured_at = now(), evidence = EXCLUDED.evidence
    `, [modelDbId, fact.capability, fact.supported, fact.evidence]);
  }
}
