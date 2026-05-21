import fs from 'fs/promises';
import path from 'path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { routeRequest, recordSuccess } from '../services/router.js';

export const agentRouter = Router();

const WORKSPACE_ROOT = path.basename(process.cwd()) === 'server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const MAX_FILE_BYTES = 120_000;
const MAX_SEARCH_RESULTS = 80;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.vite',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
]);
const BLOCKED_FILES = new Set(['.env']);
const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.env.example',
  '.go',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.yml',
  '.yaml',
]);

function toRelative(absPath: string): string {
  return path.relative(WORKSPACE_ROOT, absPath).replace(/\\/g, '/');
}

function resolveWorkspacePath(input: string): string {
  const clean = input.replace(/^[/\\]+/, '');
  const resolved = path.resolve(WORKSPACE_ROOT, clean);
  const rel = path.relative(WORKSPACE_ROOT, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes workspace');
  }
  if (rel.split(path.sep).some(part => SKIP_DIRS.has(part))) {
    throw new Error('Path is inside a blocked directory');
  }
  if (BLOCKED_FILES.has(path.basename(resolved))) {
    throw new Error('File is blocked');
  }
  return resolved;
}

function looksTextual(filePath: string): boolean {
  const base = path.basename(filePath);
  if (TEXT_EXTENSIONS.has(base)) return true;
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function walkFiles(dir: string, results: string[], limit = 600): Promise<void> {
  if (results.length >= limit) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= limit) return;
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(abs, results, limit);
      continue;
    }
    if (!entry.isFile()) continue;
    if (BLOCKED_FILES.has(entry.name)) continue;
    if (!looksTextual(abs)) continue;
    results.push(toRelative(abs));
  }
}

async function readWorkspaceFile(relativePath: string) {
  const abs = resolveWorkspacePath(relativePath);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error('Path is not a file');
  if (!looksTextual(abs)) throw new Error('Only text files are supported');
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File is too large (${stat.size} bytes)`);
  const content = await fs.readFile(abs, 'utf8');
  return { path: toRelative(abs), content, size: stat.size };
}

agentRouter.get('/status', (_req: Request, res: Response) => {
  res.json({
    status: 'ready',
    workspaceRoot: WORKSPACE_ROOT,
    capabilities: [
      'workspace_file_search',
      'workspace_file_read',
      'agent_chat',
      'safe_text_replacement',
    ],
  });
});

agentRouter.get('/files', async (req: Request, res: Response) => {
  const query = String(req.query.q ?? '').trim().toLowerCase();
  const files: string[] = [];
  await walkFiles(WORKSPACE_ROOT, files);
  const filtered = query
    ? files.filter(file => file.toLowerCase().includes(query)).slice(0, MAX_SEARCH_RESULTS)
    : files.slice(0, MAX_SEARCH_RESULTS);
  res.json({ files: filtered, total: filtered.length });
});

const readSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(12),
});

agentRouter.post('/read', async (req: Request, res: Response) => {
  const parsed = readSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const files = await Promise.all(parsed.data.paths.map(readWorkspaceFile));
  res.json({ files });
});

const chatSchema = z.object({
  message: z.string().min(1).max(20_000),
  paths: z.array(z.string().min(1)).max(8).optional(),
  language: z.enum(['en', 'fr', 'es']).optional(),
});

agentRouter.post('/chat', async (req: Request, res: Response) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { message, paths = [], language = 'en' } = parsed.data;
  const files = await Promise.all(paths.map(readWorkspaceFile));
  const fileContext = files.map(file => (
    `File: ${file.path}\n\`\`\`\n${file.content.slice(0, MAX_FILE_BYTES)}\n\`\`\``
  )).join('\n\n');

  const languageHint = {
    en: 'Answer in English.',
    fr: 'Reponds en francais.',
    es: 'Responde en espanol.',
  }[language];

  const system = [
    'You are a local coding agent connected to a developer workspace.',
    'Be precise, cite relevant files, and propose safe edits.',
    'Do not claim that you changed files unless a patch endpoint was called.',
    'When code changes are needed, return concise patch guidance or exact replacements.',
    languageHint,
  ].join('\n');

  const user = fileContext
    ? `${message}\n\nWorkspace context:\n\n${fileContext}`
    : message;

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const estimatedTokens = Math.ceil((system.length + user.length) / 4) + 1200;

  try {
    const route = routeRequest(estimatedTokens);
    const result = await route.provider.chatCompletion(route.apiKey, messages, route.modelId, {
      temperature: 0.2,
      max_tokens: 1800,
    });
    recordSuccess(route.modelDbId);
    res.json({
      content: result.choices?.[0]?.message?.content ?? '',
      routedVia: {
        platform: route.platform,
        model: route.modelId,
        displayName: route.displayName,
      },
    });
  } catch (err: any) {
    res.status(err.status ?? 503).json({
      error: {
        message: err.message ?? 'Agent request failed',
        type: 'agent_error',
      },
    });
  }
});

const replaceSchema = z.object({
  path: z.string().min(1),
  find: z.string().min(1),
  replace: z.string(),
  apply: z.boolean().optional().default(false),
});

agentRouter.post('/replace', async (req: Request, res: Response) => {
  const parsed = replaceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const abs = resolveWorkspacePath(parsed.data.path);
  const current = await fs.readFile(abs, 'utf8');
  const count = current.split(parsed.data.find).length - 1;
  if (count !== 1) {
    res.status(400).json({
      error: {
        message: `Expected exactly one match, found ${count}. Refine the text to replace.`,
      },
    });
    return;
  }

  const next = current.replace(parsed.data.find, parsed.data.replace);
  if (parsed.data.apply) {
    await fs.writeFile(abs, next, 'utf8');
  }

  res.json({
    path: toRelative(abs),
    applied: parsed.data.apply,
    changed: next !== current,
    preview: {
      before: parsed.data.find,
      after: parsed.data.replace,
    },
  });
});
