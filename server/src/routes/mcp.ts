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
