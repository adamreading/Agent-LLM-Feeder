import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getUnifiedApiKey, regenerateUnifiedKey, getPool } from '../db/index.js';
import { maskKey } from '../lib/crypto.js';
import {
  SEARCH_BACKENDS, KEYED_SEARCH_BACKENDS,
  getActiveSearchBackend, setActiveSearchBackend,
  getSearchKey, setSearchKey, clearSearchKey, loadSearchConfigIntoEnv,
} from '../services/searchConfig.js';

export const settingsRouter = Router();

// Get the unified API key
settingsRouter.get('/api-key', async (_req: Request, res: Response) => {
  res.json({ apiKey: await getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', async (_req: Request, res: Response) => {
  const newKey = await regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});

// ── Web-search config ("Search Key" card on onboarding) ─────────────────────
// The research feature's search backend + its key. Keyed backends (Tavily)
// store an encrypted secret; the active backend id is plaintext. Keys are
// NEVER returned in full — only whether one is set + a masked preview.
async function searchState() {
  const pool = getPool();
  const backend = (await getActiveSearchBackend(pool)) ?? process.env.WEB_SEARCH_BACKEND ?? 'ollama';
  const keys: Record<string, { set: boolean; masked: string | null }> = {};
  for (const id of Object.keys(KEYED_SEARCH_BACKENDS)) {
    const k = await getSearchKey(pool, id);
    keys[id] = { set: !!k, masked: k ? maskKey(k) : null };
  }
  return { backend, available: SEARCH_BACKENDS, keyed: Object.keys(KEYED_SEARCH_BACKENDS), keys };
}

settingsRouter.get('/search', async (_req: Request, res: Response) => {
  res.json(await searchState());
});

const searchSchema = z.object({
  backend: z.enum(['ollama', 'ddg', 'tavily']).optional(),
  tavily_key: z.string().min(1).optional(),
  clear: z.enum(['tavily']).optional(),
});

settingsRouter.post('/search', async (req: Request, res: Response) => {
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request', type: 'invalid_request_error' } });
    return;
  }
  const pool = getPool();
  const { backend, tavily_key, clear } = parsed.data;

  if (clear) await clearSearchKey(pool, clear);
  if (tavily_key) {
    await setSearchKey(pool, 'tavily', tavily_key.trim());
    // Pasting a key implies wanting to use it — activate tavily unless the
    // caller explicitly set a different backend in the same request.
    if (!backend) await setActiveSearchBackend(pool, 'tavily');
  }
  if (backend) await setActiveSearchBackend(pool, backend);

  // Apply to THIS running server immediately (no restart) so the next research
  // call uses it. A separate CLI research process loads the same at its start.
  await loadSearchConfigIntoEnv(pool);
  res.status(200).json(await searchState());
});
