import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { routeRequest, recordSuccess } from '../services/router.js';
import { recordVisionUnsupported } from '../services/capabilityObserve.js';
import { getPool, getUnifiedApiKey } from '../db/index.js';
import { get, run } from '../db/pgCompat.js';

export const agentRouter = Router();

// ─── Auth gate (Adam-approved, 2026-07-14) ──────────────────────────────────
// These endpoints expose the HOST filesystem — any absolute path, read-only
// (browse/read/inspect; writes are disabled below). The server binds 0.0.0.0,
// so unlike the old repo-sandboxed agent these MUST be authenticated: a
// localhost caller (the operator's own machine) is trusted tokenless, but any
// remote caller must present the unified key or a valid consumer key — the same
// tokens /v1 accepts. NOTE: /api/settings/api-key still serves the unified key
// unauthenticated, so this gate raises the bar (no unauthenticated drive-by)
// but is not a substitute for firewalling port 3001 on an untrusted network.
function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const cmp = a.length === b.length ? a : Buffer.alloc(b.length);
  return crypto.timingSafeEqual(cmp, b) && a.length === b.length;
}
const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

function isLocalReq(req: Request): boolean {
  return req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
}

async function requireAgentAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const isLocal = isLocalReq(req);
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (isLocal && !token) { next(); return; }
  if (token) {
    try {
      const row = await get<{ ok: number }>(getPool(),
        'SELECT 1 AS ok FROM consumer_keys WHERE key_hash = ? AND enabled = true', [hashToken(token)]);
      if (row) { next(); return; }
      if (timingSafeStringEqual(token, await getUnifiedApiKey())) { next(); return; }
    } catch { /* fall through to 401 */ }
    if (isLocal) { next(); return; } // localhost with an unrecognised token still trusted (matches /v1)
  }
  res.status(401).json({ error: { message: 'Unauthorized — /api/agent requires the unified API key', type: 'unauthorized' } });
}
agentRouter.use(requireAgentAuth);

// ─── Filesystem access ───────────────────────────────────────────────────────
const DEFAULT_ROOT = path.basename(process.cwd()) === 'server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const MAX_FILE_BYTES = 200_000;       // text read cap
const MAX_IMAGE_BYTES = 12_000_000;   // ~12MB raw → ~16MB base64, under the 25mb JSON limit
const MAX_SEARCH_RESULTS = 200;
const WALK_LIMIT = 1500;

// Skipped only in the RECURSIVE search walk (noise/perf). Directory browsing
// still lists these so a user can navigate in deliberately.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.vite', 'coverage', '.next', '.turbo', '.cache']);

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};
const TEXT_EXT = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js',
  '.json', '.jsx', '.md', '.mjs', '.cjs', '.py', '.rs', '.sql', '.ts', '.tsx', '.txt',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.sh', '.bash', '.zsh', '.fish',
  '.xml', '.rb', '.php', '.pl', '.lua', '.r', '.kt', '.kts', '.swift', '.scala', '.dart',
  '.vue', '.svelte', '.svg', '.gradle', '.properties', '.tsv', '.csv', '.env.example',
  '.log', '.diff', '.patch', '.gitignore', '.dockerignore', '.editorconfig',
]);
const TEXT_BASENAMES = new Set([
  'dockerfile', 'makefile', 'license', 'readme', 'changelog', 'procfile',
  '.gitignore', '.dockerignore', '.editorconfig', '.prettierrc', '.eslintrc', '.npmrc.example',
]);

// Sensitive files: blocked from READ everywhere (browse still lists them, greyed).
// This is the secret-file guard Adam kept when unlocking absolute-path access.
function isSecret(abs: string): boolean {
  const base = path.basename(abs).toLowerCase();
  const parts = abs.split(/[/\\]+/).map(p => p.toLowerCase());
  if (parts.some(p => p === '.ssh' || p === '.aws' || p === '.gnupg')) return true;
  if (base === '.env' || (base.startsWith('.env') &&
    !['.env.example', '.env.sample', '.env.template'].includes(base))) return true;
  if (['.pgpass', '.netrc', '.git-credentials', 'credentials', '.npmrc', '.htpasswd', '.dockercfg'].includes(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return true;
  const ext = path.extname(base);
  if (['.pem', '.key', '.ppk', '.p12', '.pfx', '.keystore', '.jks', '.asc', '.gpg'].includes(ext)) return true;
  return false;
}

type FileKind = 'image' | 'text' | 'unknown';
function classify(abs: string): FileKind {
  const ext = path.extname(abs).toLowerCase();
  const base = path.basename(abs).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext) || TEXT_BASENAMES.has(base)) return 'text';
  return 'unknown';
}

// Resolve any user-supplied path to an absolute path (expanding a leading ~).
// No sandbox check — full-machine access is intentional and Adam-approved.
function toAbs(input: string): string {
  if (!input) return DEFAULT_ROOT;
  let p = input.trim();
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

async function walk(dir: string, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= limit) return;
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { await walk(abs, out, limit); continue; }
    if (!e.isFile()) continue;
    if (isSecret(abs)) continue;
    const k = classify(abs);
    if (k === 'text' || k === 'image') out.push(abs);
  }
}

agentRouter.get('/status', async (_req: Request, res: Response) => {
  const roots: { label: string; path: string }[] = [
    { label: 'Repo', path: DEFAULT_ROOT },
    { label: 'Home', path: os.homedir() },
  ];
  // Surface mounted Windows drives (WSL: /mnt/c, /mnt/d, …) as quick roots.
  try {
    const mnt = await fs.readdir('/mnt');
    for (const d of mnt.sort()) if (/^[a-z]$/.test(d)) roots.push({ label: `${d.toUpperCase()}: (Windows)`, path: `/mnt/${d}` });
  } catch { /* not WSL / no /mnt */ }
  res.json({
    status: 'ready',
    platform: process.platform,
    cwd: process.cwd(),
    home: os.homedir(),
    defaultRoot: DEFAULT_ROOT,
    roots,
    capabilities: ['fs_browse', 'fs_read', 'vision_read'],
    writeEnabled: process.env.AGENT_ALLOW_WRITE === '1',
  });
});

// Browse a single directory (dirs + files, one level). Secrets are listed but
// flagged `blocked` so the UI can grey them out (never readable).
agentRouter.get('/browse', async (req: Request, res: Response) => {
  const dir = toAbs(String(req.query.path ?? ''));
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) { res.status(400).json({ error: { message: 'Not a directory' } }); return; }
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    const entries = dirents.map(d => {
      const abs = path.join(dir, d.name);
      const isDir = d.isDirectory();
      return {
        name: d.name,
        path: abs,
        type: isDir ? 'dir' as const : 'file' as const,
        kind: isDir ? undefined : classify(abs),
        blocked: !isDir && isSecret(abs),
        hidden: d.name.startsWith('.'),
      };
    }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    const parent = path.dirname(dir);
    res.json({ path: dir, parent: parent === dir ? null : parent, entries });
  } catch (e: any) {
    const code = e.code === 'ENOENT' ? 404 : e.code === 'EACCES' ? 403 : 500;
    res.status(code).json({ error: { message: `Cannot read ${dir}: ${e.code ?? e.message}` } });
  }
});

// Recursive filename search under a root (text + image files; secrets excluded).
agentRouter.get('/files', async (req: Request, res: Response) => {
  const root = toAbs(String(req.query.root ?? req.query.path ?? ''));
  const q = String(req.query.q ?? '').trim().toLowerCase();
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) { res.status(400).json({ error: { message: 'root is not a directory' } }); return; }
  } catch (e: any) {
    res.status(e.code === 'ENOENT' ? 404 : 500).json({ error: { message: `Cannot read ${root}: ${e.code ?? e.message}` } });
    return;
  }
  const out: string[] = [];
  await walk(root, out, WALK_LIMIT);
  const filtered = (q ? out.filter(f => f.toLowerCase().includes(q)) : out).slice(0, MAX_SEARCH_RESULTS);
  res.json({ files: filtered, total: filtered.length, root });
});

// Read files by absolute path. Text → utf8 content; image → base64 data URI (so
// the client can attach it as an image_url part for vision routing). Secrets and
// binaries are refused per-file (never fails the whole batch).
async function readOne(input: string) {
  const abs = toAbs(input);
  try {
    if (isSecret(abs)) return { path: abs, error: 'blocked: sensitive file' };
    const st = await fs.stat(abs);
    if (!st.isFile()) return { path: abs, error: 'not a file' };
    const kind = classify(abs);
    if (kind === 'image') {
      if (st.size > MAX_IMAGE_BYTES) return { path: abs, error: `image too large (${st.size} bytes)` };
      const buf = await fs.readFile(abs);
      const mime = IMAGE_MIME[path.extname(abs).toLowerCase()] ?? 'image/png';
      return { path: abs, kind: 'image' as const, mime, size: st.size, dataUri: `data:${mime};base64,${buf.toString('base64')}` };
    }
    if (st.size > MAX_FILE_BYTES) return { path: abs, error: `file too large (${st.size} bytes)` };
    const buf = await fs.readFile(abs);
    if (kind === 'unknown' && buf.subarray(0, 8000).includes(0)) return { path: abs, error: 'binary file (not text)' };
    return { path: abs, kind: 'text' as const, size: st.size, content: buf.toString('utf8') };
  } catch (e: any) {
    return { path: abs, error: e.code ?? e.message };
  }
}

const readSchema = z.object({ paths: z.array(z.string().min(1)).min(1).max(12) });

agentRouter.post('/read', async (req: Request, res: Response) => {
  const parsed = readSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } }); return; }
  const files = await Promise.all(parsed.data.paths.map(readOne));
  res.json({ files });
});

// ─── Output files ────────────────────────────────────────────────────────────
// The agent can save a response to a file in a FIXED repo-local dir (<repo>/tmp,
// gitignored), which the UI then lists and downloads. Kept inside the repo (not
// the OS /tmp) so outputs are predictable, self-contained, and easy to clear.
const OUTPUT_DIR = path.join(DEFAULT_ROOT, 'tmp');
const OUTPUT_MIME: Record<string, string> = { md: 'text/markdown', txt: 'text/plain', pdf: 'application/pdf' };

function safeOutputName(name: string, format: string): string {
  const stem = (name || 'agent-output')
    .replace(/\.[^.]*$/, '')                 // drop any extension the user typed
    .replace(/[^\w.\- ]/g, '_').replace(/\s+/g, '-')
    .slice(0, 80) || 'agent-output';
  return `${stem}.${format}`;
}

// Plain-text PDF (pdfkit auto-wraps + paginates). Markdown source is written
// verbatim — the .md format preserves structure; the PDF is a readable dump.
function writePdf(abs: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54, size: 'A4' });
    const stream = createWriteStream(abs);
    doc.pipe(stream);
    doc.font('Courier').fontSize(10).text(content, { align: 'left' });
    doc.end();
    stream.on('finish', () => resolve());
    stream.on('error', reject);
    doc.on('error', reject);
  });
}

const outputSchema = z.object({
  filename: z.string().max(120).optional(),
  format: z.enum(['md', 'txt', 'pdf']),
  content: z.string().min(1).max(500_000),
});

agentRouter.post('/output', async (req: Request, res: Response) => {
  const parsed = outputSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } }); return; }
  const { filename, format, content } = parsed.data;
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const name = safeOutputName(filename ?? '', format);
    const abs = path.join(OUTPUT_DIR, name);
    if (format === 'pdf') await writePdf(abs, content);
    else await fs.writeFile(abs, content, 'utf8');
    const st = await fs.stat(abs);
    res.json({ name, size: st.size, path: abs });
  } catch (e: any) {
    res.status(500).json({ error: { message: e.message ?? 'write failed' } });
  }
});

agentRouter.get('/outputs', async (_req: Request, res: Response) => {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const names = await fs.readdir(OUTPUT_DIR);
    const files: { name: string; size: number; mtime: number }[] = [];
    for (const n of names) {
      const st = await fs.stat(path.join(OUTPUT_DIR, n)).catch(() => null);
      if (st?.isFile()) files.push({ name: n, size: st.size, mtime: st.mtimeMs });
    }
    files.sort((a, b) => b.mtime - a.mtime);
    res.json({ files, dir: OUTPUT_DIR });
  } catch (e: any) {
    res.status(500).json({ error: { message: e.message } });
  }
});

// Serve a file's bytes as an attachment. The UI fetches this WITH the auth
// header, turns it into a blob, and triggers the browser download — so the
// download inherits the same gate as everything else under /api/agent.
agentRouter.get('/output/:name', async (req: Request, res: Response) => {
  const name = path.basename(String(req.params.name)); // strip any path — confine to OUTPUT_DIR
  const abs = path.join(OUTPUT_DIR, name);
  if (path.dirname(abs) !== OUTPUT_DIR) { res.status(400).json({ error: { message: 'invalid name' } }); return; }
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    res.setHeader('Content-Type', OUTPUT_MIME[path.extname(name).slice(1)] ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    createReadStream(abs).pipe(res);
  } catch {
    res.status(404).json({ error: { message: 'not found' } });
  }
});

agentRouter.delete('/output/:name', async (req: Request, res: Response) => {
  const name = path.basename(String(req.params.name));
  const abs = path.join(OUTPUT_DIR, name);
  if (path.dirname(abs) !== OUTPUT_DIR) { res.status(400).json({ error: { message: 'invalid name' } }); return; }
  await fs.unlink(abs).catch(() => {});
  res.json({ ok: true });
});

// ─── Response feedback (thumbs up/down) ──────────────────────────────────────
// Content-free rating of a served response. Repeated DOWN votes on an image
// response demote the model's vision capability (observed=false) once they hit a
// threshold — a human signal feeding the same path a genuine provider image
// rejection uses (capabilityObserve.recordVisionUnsupported). Recovery is
// automatic: a later genuine successful image completion re-observes vision=true.
const feedbackSchema = z.object({
  rating: z.enum(['up', 'down']),
  platform: z.string().max(80).optional(),
  modelId: z.string().max(200).optional(),
  taskClass: z.string().max(40).nullable().optional(),
  hadImage: z.boolean().optional(),
  consumer: z.string().max(64).optional(),
});

agentRouter.post('/feedback', async (req: Request, res: Response) => {
  const parsed = feedbackSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } }); return; }
  const { rating, platform, modelId, taskClass = null, hadImage = false, consumer = 'agent-ui' } = parsed.data;
  try {
    let modelDbId: number | null = null;
    if (platform && modelId) {
      const row = await get<{ id: number }>(getPool(), 'SELECT id FROM models WHERE platform = ? AND model_id = ?', [platform, modelId]);
      modelDbId = row?.id ?? null;
    }
    await run(getPool(),
      'INSERT INTO response_feedback (model_db_id, platform, model_id, task_class, had_image, rating, consumer) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [modelDbId, platform ?? null, modelId ?? null, taskClass, hadImage, rating, consumer]);

    let visionDemoted = false;
    if (rating === 'down' && hadImage && modelDbId) {
      const threshold = parseInt(process.env.FEEDBACK_VISION_DEMOTE_THRESHOLD || '3', 10);
      const cnt = await get<{ n: string }>(getPool(),
        "SELECT count(*) AS n FROM response_feedback WHERE model_db_id = ? AND had_image = true AND rating = 'down'", [modelDbId]);
      const downs = parseInt(cnt?.n ?? '0', 10);
      if (downs >= threshold) {
        await recordVisionUnsupported(modelDbId, `${downs} user vision thumbs-down (UI feedback)`);
        visionDemoted = true;
      }
    }
    res.json({ ok: true, modelDbId, visionDemoted });
  } catch (e: any) {
    res.status(500).json({ error: { message: e.message ?? 'feedback failed' } });
  }
});

// Legacy server-side chat (kept for API back-compat). The Agent UI now routes
// through /v1/chat/completions instead, so it inherits web-search augment,
// vision routing, model pinning, and the classifier — none of which this
// endpoint does. Text file context only.
const chatSchema = z.object({
  message: z.string().min(1).max(20_000),
  paths: z.array(z.string().min(1)).max(8).optional(),
  language: z.enum(['en', 'fr', 'es']).optional(),
});

agentRouter.post('/chat', async (req: Request, res: Response) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } }); return; }
  const { message, paths = [], language = 'en' } = parsed.data;
  const read = await Promise.all(paths.map(readOne));
  const fileContext = read
    .filter((f): f is { path: string; kind: 'text'; size: number; content: string } => 'content' in f)
    .map(f => `File: ${f.path}\n\`\`\`\n${f.content.slice(0, MAX_FILE_BYTES)}\n\`\`\``)
    .join('\n\n');

  const languageHint = { en: 'Answer in English.', fr: 'Reponds en francais.', es: 'Responde en espanol.' }[language];
  const system = [
    'You are a local coding agent connected to a developer workspace.',
    'Be precise, cite relevant files, and propose safe edits.',
    'Do not claim that you changed files unless a patch endpoint was called.',
    'When code changes are needed, return concise patch guidance or exact replacements.',
    languageHint,
  ].join('\n');
  const user = fileContext ? `${message}\n\nWorkspace context:\n\n${fileContext}` : message;
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const estimatedTokens = Math.ceil((system.length + user.length) / 4) + 1200;

  try {
    const route = await routeRequest({ estimatedTokens });
    const result = await route.provider.chatCompletion(route.apiKey, messages, route.modelId, { temperature: 0.2, max_tokens: 1800 });
    recordSuccess(route.modelDbId);
    res.json({
      content: result.choices?.[0]?.message?.content ?? '',
      routedVia: { platform: route.platform, model: route.modelId, displayName: route.displayName },
    });
  } catch (err: any) {
    res.status(err.status ?? 503).json({ error: { message: err.message ?? 'Agent request failed', type: 'agent_error' } });
  }
});

// Write/replace — DISABLED by default (Adam, 2026-07-14: read-only browse).
// With full-machine scope an unauthenticated-adjacent write would let a caller
// corrupt any file, so writes stay off unless an operator opts in with
// AGENT_ALLOW_WRITE=1 (and even then secrets stay blocked).
const replaceSchema = z.object({
  path: z.string().min(1),
  find: z.string().min(1),
  replace: z.string(),
  apply: z.boolean().optional().default(false),
});

agentRouter.post('/replace', async (req: Request, res: Response) => {
  if (process.env.AGENT_ALLOW_WRITE !== '1') {
    res.status(403).json({ error: { message: 'Agent write is disabled (read-only mode). Set AGENT_ALLOW_WRITE=1 to enable.', type: 'write_disabled' } });
    return;
  }
  const parsed = replaceSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } }); return; }
  const abs = toAbs(parsed.data.path);
  if (isSecret(abs)) { res.status(403).json({ error: { message: 'File is blocked' } }); return; }
  const current = await fs.readFile(abs, 'utf8');
  const count = current.split(parsed.data.find).length - 1;
  if (count !== 1) {
    res.status(400).json({ error: { message: `Expected exactly one match, found ${count}. Refine the text to replace.` } });
    return;
  }
  const next = current.replace(parsed.data.find, parsed.data.replace);
  if (parsed.data.apply) await fs.writeFile(abs, next, 'utf8');
  res.json({ path: abs, applied: parsed.data.apply, changed: next !== current, preview: { before: parsed.data.find, after: parsed.data.replace } });
});
