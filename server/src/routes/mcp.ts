// MCP server (Model Context Protocol) — lets fleet agents query the feeder's
// LIVE routing state as tools instead of guessing which model to ask for. Wraps
// the same explainRouting() the wiki/analytics use, so what an agent sees here is
// exactly what the router would do. Read-only introspection; no request is sent
// to any provider and nothing is mutated.
//
// Transport: Streamable HTTP in STATELESS mode (a fresh server+transport per POST,
// no session persistence) — simplest correct shape for a pure query surface, and
// it matches how our callers (short-lived agent turns) use it. Mounted at /mcp.
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { explainRouting } from '../services/router.js';
import { poolSearch, type SearchSkipReason } from '../services/searchPool.js';
import { getCachedSearch, setCachedSearch } from '../services/searchCache.js';

// Concise, agent-friendly projection of an explainRouting row.
function projectRow(r: Awaited<ReturnType<typeof explainRouting>>['rows'][number]) {
  return {
    model: `${r.platform}/${r.modelId}`,
    display_name: r.displayName,
    status: r.status, // eligible | disabled | no_key | cooling
    task_score: r.taskScore,
    intelligence_rank: r.intelligenceRank,
    health_score: r.healthScore,
    latency_ms: r.latencyMs,
    cost_tier: r.costTier,
    ...(r.status !== 'eligible' ? { unavailable_reason: r.disabledReason ?? r.status } : {}),
  };
}

// web_search status vocabulary. The whole point of naming these separately is
// that "the web has nothing on this" and "we could not ask the web" are DIFFERENT
// answers an agent must act on differently (openshell, 2026-08-08: DDG returned
// HTTP 200 + empty body and the agent honestly said "not in the evidence", which
// was uninterpretable). searchPool already classifies; this surfaces it.
const SEARCH_STATUS: Record<SearchSkipReason, { status: string; isError: boolean; detail: string }> = {
  'throttled':  { status: 'throttled',      isError: true,  detail: 'Every eligible search engine is rate-limited, in cooldown, or out of free quota right now. The web was NOT consulted. Retry later; do not treat this as "no information exists".' },
  'no-config':  { status: 'not_configured', isError: true,  detail: 'No search engine in the feeder pool is configured with a usable key. The web was NOT consulted. This is a feeder config gap, not an empty web.' },
  'error':      { status: 'error',          isError: true,  detail: 'Every engine tried failed (network/timeout/upstream error). The web was NOT consulted successfully. Retry.' },
  'no-results': { status: 'no_results',     isError: false, detail: 'The search RAN successfully and the engine(s) returned zero results. This is a real negative: the query genuinely matched nothing.' },
};

// The paid last-resort tier (You.com) is metered per-JOB on a run id. MCP callers
// have no run id of their own, so every MCP search shares one synthetic job —
// the existing $5 FEEDER_YOU_JOB_CAP_USD then bounds what the whole MCP surface
// can spend on paid search between restarts. Free engines are unaffected.
const MCP_SEARCH_RUN_ID = 'mcp:web_search';

// Build a fresh server instance. Stateless transport ⇒ one per request.
function createFeederMcpServer(): McpServer {
  const server = new McpServer({ name: 'feeder', version: '1.0.0' });

  server.registerTool(
    'list_usable_models',
    {
      title: 'List usable models',
      description:
        'Return the models the feeder would ACTUALLY route to right now, best-first, for an optional task class (coding, math, reasoning, creative, long_context, multi_turn). Only currently-eligible models (enabled, keyed, not cooling). Use this to pick a model instead of guessing.',
      inputSchema: {
        task_class: z.string().optional().describe('coding | math | reasoning | creative | long_context | multi_turn; omit for overall'),
        limit: z.number().int().positive().max(50).optional().describe('max models to return (default 10)'),
      },
    },
    async ({ task_class, limit }) => {
      const { taskType, rows } = await explainRouting(task_class ?? null);
      const usable = rows.filter(r => r.status === 'eligible').slice(0, limit ?? 10).map(projectRow);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ task_type: taskType, count: usable.length, models: usable }, null, 2),
        }],
      };
    },
  );

  server.registerTool(
    'explain_routing',
    {
      title: 'Explain routing',
      description:
        'Full routing table for an optional task class: every model in the fallback set, in routing order, with its task score, health, latency, and status (eligible / disabled / no_key / cooling) plus the reason it is unavailable. Use to debug why a model is or is not being chosen.',
      inputSchema: {
        task_class: z.string().optional().describe('coding | math | reasoning | creative | long_context | multi_turn; omit for overall'),
      },
    },
    async ({ task_class }) => {
      const { taskType, rows } = await explainRouting(task_class ?? null);
      const projected = rows.map(projectRow);
      const eligible = projected.filter(r => r.status === 'eligible').length;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ task_type: taskType, total: projected.length, eligible, models: projected }, null, 2),
        }],
      };
    },
  );

  // Third tool (openshell ask, Adam-authorised 2026-08-08). Gives a sandboxed
  // agent real web search WITHOUT any key leaving this process: the agent calls
  // the tool, feeder holds the encrypted per-provider keys in Postgres and picks
  // the engine. Same pool/cache/cooldown machinery the /v1 augment path uses, so
  // an MCP burst draws down the same quota windows and cannot self-exhaust the
  // free tier independently of it.
  server.registerTool(
    'web_search',
    {
      title: 'Web search',
      description:
        'Search the live web through the feeder search pool and return ranked results. Feeder picks the engine (load-balanced across the activated free bank, quota- and cooldown-aware, paid tier last resort); no API key is needed by, or exposed to, the caller. Always check the returned `status`: `ok` and `no_results` mean the web WAS consulted, `throttled` / `not_configured` / `error` mean it was NOT — do not report "nothing found" for those.',
      inputSchema: {
        query: z.string().min(1).describe('the search query'),
        max_results: z.number().int().min(1).max(10).optional().describe('max results to return (default 5)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, max_results }) => {
      const max = max_results ?? 5;
      const project = (r: { title: string; url: string; content: string }) => ({ title: r.title, url: r.url, snippet: r.content });

      // Shared TTL cache first — same cache the swarm augment path uses, so a
      // sandboxed agent and a swarm worker asking the same question in the same
      // 10 minutes cost one real search between them.
      const cached = getCachedSearch(query);
      if (cached) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            query, status: 'ok', cached: true, backend: null, attempted: [],
            detail: 'Served from the shared 10-minute search cache; no engine was called and no quota was spent. The originating engine is not recorded per cache entry.',
            count: Math.min(cached.length, max), results: cached.slice(0, max).map(project),
          }, null, 2) }],
        };
      }

      const { results, reason, backend, attempted } = await poolSearch(query, max, { runId: MCP_SEARCH_RUN_ID });

      if (reason === null) {
        setCachedSearch(query, results);
        return {
          content: [{ type: 'text', text: JSON.stringify({
            query, status: 'ok', cached: false,
            // The engine that ACTUALLY served this, plus everything tried before
            // it. If the usual engine is cooling and the pool fell through to a
            // weaker one, that is visible here rather than silently worse.
            backend, attempted,
            count: results.length, results: results.slice(0, max).map(project),
          }, null, 2) }],
        };
      }

      const s = SEARCH_STATUS[reason];
      return {
        isError: s.isError,
        content: [{ type: 'text', text: JSON.stringify({
          query, status: s.status, cached: false, backend: null, attempted,
          detail: s.detail, count: 0, results: [],
        }, null, 2) }],
      };
    },
  );

  return server;
}

export const mcpRouter = Router();

// One stateless request/response cycle. A new server+transport is created and
// torn down per POST; the SDK handles the JSON-RPC framing (initialize /
// tools/list / tools/call) over the request body express.json() already parsed.
mcpRouter.post('/', async (req: Request, res: Response) => {
  const server = createFeederMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[MCP] request handling failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

// Stateless server: no long-lived SSE stream or session to GET/DELETE.
const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: stateless MCP server (use POST).' }, id: null });
mcpRouter.get('/', methodNotAllowed);
mcpRouter.delete('/', methodNotAllowed);
