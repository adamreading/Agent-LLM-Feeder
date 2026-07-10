import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getPool } from '../db/index.js';
import { all, run, runReturningId } from '../db/pgCompat.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { clearKeyState } from '../services/ratelimit.js';
import { clearHealthState } from '../services/health.js';

export const keysRouter = Router();

// Active providers — must match providers/index.ts registrations + shared/types.ts Platform.
// Hugging Face, Moonshot, and MiniMax direct integrations were dropped in V4
// (see migrateModelsV4 comment block).
const PLATFORMS = [
  'google', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'pollinations', 'llm7', 'opencode',
] as const;

const addKeySchema = z.object({
  platform: z.enum(PLATFORMS),
  key: z.string().min(1),
  label: z.string().optional(),
});

// List all keys (masked)
keysRouter.get('/', async (_req: Request, res: Response) => {
  const rows = await all<any>(getPool(), 'SELECT * FROM api_keys ORDER BY created_at DESC');

  const keys = rows.map(row => {
    let maskedKey = '****';
    try {
      const realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      status: row.status,
      enabled: row.enabled,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
    };
  });

  res.json(keys);
});

// Add a key
keysRouter.post('/', async (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { platform, key, label } = parsed.data;
  const { encrypted, iv, authTag } = encrypt(key);

  const id = await runReturningId(getPool(), `
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', true)
  `, [platform, label ?? '', encrypted, iv, authTag]);

  res.status(201).json({
    id,
    platform,
    label: label ?? '',
    maskedKey: maskKey(key),
    status: 'unknown',
    enabled: true,
  });
});

// Delete a key
keysRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const result = await run(getPool(), 'DELETE FROM api_keys WHERE id = ?', [id]);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  // Deletion is already immediately honored for routing (routeRequest
  // re-queries api_keys fresh every call) — this just prevents the
  // rate-limit/cooldown/health-failure state keyed by this id from becoming
  // a permanently orphaned entry (found live 2026-07-08, Adam's check).
  clearKeyState(id);
  clearHealthState(id);

  res.json({ success: true });
});

// Toggle enable/disable
keysRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const result = await run(getPool(), 'UPDATE api_keys SET enabled = ? WHERE id = ?', [enabled, id]);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  res.json({ success: true, enabled });
});
