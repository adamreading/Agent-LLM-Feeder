import { Router, type Request } from 'express';
import { getPool } from '../db/index.js';
import { runCatalogSync, getLastSyncStatus } from '../services/catalogSync.js';

// Catalog-sync control surface. GET status is public (read-only, no secrets);
// POST trigger is LOCALHOST-ONLY (the operator's own machine) — it spends tokens
// (bounded liveness + research) and mutates the catalog, so it must not be
// reachable from the fleet, matching /api/swarm/budget + /api/agent.
export const catalogRouter = Router();

function isLocalReq(req: Request): boolean {
  return req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
}

// Last daily catalog-sync run: when it ran + the full per-run summary
// (per-platform poll status, added/retired/enabled/researched counts).
catalogRouter.get('/sync-status', async (_req, res) => {
  const status = await getLastSyncStatus(getPool());
  res.json(status);
});

// Manually trigger a catalog sync (localhost). Runs in the background and returns
// immediately (a full run can take minutes: bounded liveness + research calls);
// poll GET /sync-status for the result. Pass ?wait=1 to block and return the
// summary directly (handy for a one-off verification run).
catalogRouter.post('/sync', async (req, res) => {
  if (!isLocalReq(req)) {
    res.status(403).json({ error: { message: 'POST /api/catalog/sync is localhost-only', type: 'forbidden' } });
    return;
  }
  const opts = {
    researchLimit: typeof req.body?.researchLimit === 'number' ? req.body.researchLimit : undefined,
    enableLimit: typeof req.body?.enableLimit === 'number' ? req.body.enableLimit : undefined,
    retireThreshold: typeof req.body?.retireThreshold === 'number' ? req.body.retireThreshold : undefined,
  };
  if (req.query.wait === '1' || req.query.wait === 'true') {
    const summary = await runCatalogSync(getPool(), opts);
    res.json(summary);
    return;
  }
  void runCatalogSync(getPool(), opts);
  res.status(202).json({ started: true, message: 'catalog sync started — poll GET /api/catalog/sync-status for the result' });
});
