import './env.js';
import dns from 'node:dns';
// This WSL2 box has NO IPv6 egress (measured 2026-09-06: `curl -6` → no route) but
// the static resolvers return AAAA records first and Node's default order is
// `verbatim`, so every fresh provider connection tried a dead v6 path before
// Happy-Eyeballs fell back (~250ms tax + a flake surface during egress blips).
// Prefer v4 outright. Harmless on a host that does have v6 (v6 is still tried).
dns.setDefaultResultOrder('ipv4first');
import { createApp } from './app.js';
import { initDb, closeDb, getPool } from './db/index.js';
import { startHealthChecker, stopHealthChecker } from './services/health.js';
import { loadSearchConfigIntoEnv } from './services/searchConfig.js';
import { autoOnboardNewArrivals } from './services/autoOnboard.js';
import { startCatalogSyncScheduler, stopCatalogSyncScheduler } from './services/catalogSyncScheduler.js';
import { startLeaderboardSyncScheduler, stopLeaderboardSyncScheduler } from './services/leaderboardSyncScheduler.js';
import type { Server } from 'http';

const PORT = process.env.PORT ?? 3001;

async function main() {
  await initDb();
  // Bridge UI-managed web-search config (backend + keys) from the DB into env
  // before anything reads it (the research feature's webSearch.ts).
  await loadSearchConfigIntoEnv(getPool());
  const app = createApp();

  const server: Server = app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Proxy endpoint: http://0.0.0.0:${PORT}/v1/chat/completions`);
    startHealthChecker();
    // Auto-probe + auto-research any new/never-onboarded models, in the
    // background a few seconds after boot so it never delays serving. Idempotent
    // — only genuine new arrivals / gaps trigger work (see autoOnboard.ts).
    setTimeout(() => { void autoOnboardNewArrivals(getPool()); }, 8000);
    // Daily catalog sync: poll each provider's live /models list, add new
    // models (research → wiki), soft-retire ones that disappeared upstream.
    // In-process daily timer (feeder has no cron/supervisor); see catalogSync.ts.
    startCatalogSyncScheduler(getPool());
    // Weekly zero-token quality-prior import (arena.ai + Artificial Analysis);
    // see leaderboardSync.ts. First due-check ~60s after boot.
    startLeaderboardSyncScheduler(getPool());
  });

  // Drain-and-flip cutover support: stop accepting new connections, let
  // in-flight requests finish, then close the DB pool cleanly. Used both for
  // the SQLite→Postgres cutover and as general graceful-shutdown hygiene.
  const shutdown = async (signal: string) => {
    console.log(`\n[Shutdown] ${signal} received, draining...`);
    stopHealthChecker();
    stopCatalogSyncScheduler();
    stopLeaderboardSyncScheduler();
    server.close(async () => {
      await closeDb();
      console.log('[Shutdown] Drained and closed cleanly.');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(console.error);
