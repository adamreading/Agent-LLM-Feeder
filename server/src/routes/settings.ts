import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getUnifiedApiKey, regenerateUnifiedKey, getPool } from '../db/index.js';
import { maskKey } from '../lib/crypto.js';
import {
  SEARCH_BACKENDS, KEYED_SEARCH_BACKENDS, SEARCH_PROVIDER_CATALOG, isKnownBackend, isPaidBackend,
  getActiveSearchBackend, setActiveSearchBackend,
  getSearchPool, setSearchPool, addToPool, removeFromPool,
  getSearchKey, setSearchKey, clearSearchKey, loadSearchConfigIntoEnv,
} from '../services/searchConfig.js';
import { getBackendById } from '../services/webSearch.js';
import { getSearchHealth, YOU_CAPS } from '../services/searchPool.js';

// Keep the legacy single-active (web_search_backend) pointing at a member of the
// pool — it back-stops searchConfigured() (sync) + any legacy reader. Prefer a
// FREE member; fall back to the first, or leave as-is if the pool is empty.
async function syncLegacyActive(pool: any, poolIds: string[]): Promise<void> {
  if (poolIds.length === 0) return;
  const cur = await getActiveSearchBackend(pool);
  if (cur && poolIds.includes(cur)) return;
  const free = poolIds.find((id) => !isPaidBackend(id));
  await setActiveSearchBackend(pool, free ?? poolIds[0]);
}

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

// ── Web-search config ("Search Providers" card on Onboarding + Key Vault) ────
// The research feature's search backend + per-provider keys. Catalog-driven
// (SEARCH_PROVIDER_CATALOG). Keyed backends store an encrypted secret per
// provider (search_key_<id>); the active backend id is plaintext. Keys are
// NEVER returned in full — only whether one is set + a masked preview.
async function searchState() {
  const pool = getPool();
  const backend = (await getActiveSearchBackend(pool)) ?? process.env.WEB_SEARCH_BACKEND ?? 'ollama';
  const inPool = new Set(await getSearchPool(pool));
  const health = new Map((await getSearchHealth()).map((h) => [h.backend, h]));
  const providers = [];
  for (const p of SEARCH_PROVIDER_CATALOG) {
    let keySet = false;
    let keyMasked: string | null = null;
    if (p.keyed) {
      const k = await getSearchKey(pool, p.id);
      keySet = !!k;
      keyMasked = k ? maskKey(k) : null;
    }
    const h = health.get(p.id);
    providers.push({
      id: p.id, name: p.name, keyed: p.keyed, tier: p.tier, note: p.note, paid: !!p.paid,
      getUrl: p.getUrl ?? null, prefix: p.prefix ?? null,
      active: p.id === backend,      // legacy single-active (back-compat)
      inPool: inPool.has(p.id),      // activated bank membership (the new model)
      keySet, keyMasked,
      stats: h ? {
        recentLatencyMs: h.recent_latency_ms, successCount: h.success_count, failCount: h.fail_count,
        callsTotal: h.calls_total, cooldownUntil: h.cooldown_until, lastError: h.last_error,
        lastUsedAt: h.last_used_at, estSpendUsd: h.estSpendUsd,
      } : null,
    });
  }
  // `available`/`keyed` retained for any legacy consumer; `providers` is the
  // catalog the UI renders from. `youCaps` powers the You.com spend display.
  return {
    backend, providers, available: SEARCH_BACKENDS, keyed: Object.keys(KEYED_SEARCH_BACKENDS),
    pool: [...inPool], youCaps: YOU_CAPS,
  };
}

settingsRouter.get('/search', async (_req: Request, res: Response) => {
  res.json(await searchState());
});

const searchSchema = z.object({
  activate: z.string().optional(),
  setKey: z.object({ backend: z.string(), key: z.string().min(1) }).optional(),
  clearKey: z.string().optional(),
  // Add/remove an engine from the activated BANK (the load-balanced pool).
  pool: z.object({ backend: z.string(), action: z.enum(['add', 'remove']) }).optional(),
}).refine((d) => d.activate || d.setKey || d.clearKey || d.pool, { message: 'No action given' });

settingsRouter.post('/search', async (req: Request, res: Response) => {
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request', type: 'invalid_request_error' } });
    return;
  }
  const pool = getPool();
  const { activate, setKey, clearKey, pool: poolOp } = parsed.data;

  // Validate every referenced backend id against the catalog.
  for (const id of [activate, setKey?.backend, clearKey, poolOp?.backend].filter(Boolean) as string[]) {
    if (!isKnownBackend(id)) {
      res.status(400).json({ error: { message: `Unknown search backend '${id}'.`, type: 'invalid_request_error' } });
      return;
    }
  }

  if (clearKey) {
    await clearSearchKey(pool, clearKey);
    await removeFromPool(pool, clearKey); // a keyless-again engine can't serve — drop it from the bank
  }
  if (setKey) {
    await setSearchKey(pool, setKey.backend, setKey.key.trim());
    // Pasting a key implies wanting to use it — add that backend to the bank
    // unless the caller is doing an explicit activate/pool op in the same request.
    if (!activate && !poolOp) await addToPool(pool, setKey.backend);
  }
  if (poolOp) {
    if (poolOp.action === 'add') {
      // Don't add a keyed engine with no key (would just be skipped as unconfigured).
      const envVar = KEYED_SEARCH_BACKENDS[poolOp.backend];
      if (envVar) {
        const hasKey = !!(await getSearchKey(pool, poolOp.backend)) || (setKey && setKey.backend === poolOp.backend);
        if (!hasKey) {
          res.status(400).json({ error: { message: `'${poolOp.backend}' needs a key before it can join the bank.`, type: 'invalid_request_error' } });
          return;
        }
      }
      await addToPool(pool, poolOp.backend);
    } else {
      await removeFromPool(pool, poolOp.backend);
    }
    await syncLegacyActive(pool, await getSearchPool(pool));
  }
  if (activate) {
    // Don't activate a keyed backend that has no key (would break research).
    const envVar = KEYED_SEARCH_BACKENDS[activate];
    if (envVar) {
      const hasKey = !!(await getSearchKey(pool, activate));
      if (!hasKey && !(setKey && setKey.backend === activate)) {
        res.status(400).json({ error: { message: `'${activate}' needs a key before it can be activated.`, type: 'invalid_request_error' } });
        return;
      }
    }
    await setActiveSearchBackend(pool, activate);
    await addToPool(pool, activate); // legacy activate also joins the bank (non-destructive)
  }

  // Apply to THIS running server immediately (no restart) so the next research
  // call uses it. A separate CLI research process loads the same at its start.
  await loadSearchConfigIntoEnv(pool);
  res.status(200).json(await searchState());
});

// Verify a backend by running ONE live query. Tests the stored key, or a
// freshly-typed `key` (verify-before-save) injected only for the duration of the
// check. Consumes a single search-quota unit — user-initiated only.
const verifySchema = z.object({ backend: z.string(), key: z.string().min(1).optional() });

settingsRouter.post('/search/verify', async (req: Request, res: Response) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success || !isKnownBackend(parsed.data.backend)) {
    res.status(400).json({ error: { message: 'Invalid request', type: 'invalid_request_error' } });
    return;
  }
  const { backend, key } = parsed.data;
  const be = getBackendById(backend);
  const meta = SEARCH_PROVIDER_CATALOG.find((p) => p.id === backend);
  if (!be || !meta) {
    res.status(400).json({ error: { message: `Unknown search backend '${backend}'.`, type: 'invalid_request_error' } });
    return;
  }
  const pool = getPool();
  const envVar = meta.envVar;
  let restore: string | undefined;
  let had = false;
  if (meta.keyed && envVar) {
    had = envVar in process.env;
    restore = process.env[envVar];
    const effective = key?.trim() || (await getSearchKey(pool, backend)) || '';
    if (!effective) {
      res.json({ ok: false, error: 'No key set for this provider.' });
      return;
    }
    process.env[envVar] = effective;
  }
  try {
    const results = await be.search('feeder web search connectivity check', 1);
    res.json({ ok: true, count: results.length });
  } catch (e) {
    res.json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) });
  } finally {
    if (meta.keyed && envVar) {
      if (had) process.env[envVar] = restore;
      else delete process.env[envVar];
    }
  }
});
