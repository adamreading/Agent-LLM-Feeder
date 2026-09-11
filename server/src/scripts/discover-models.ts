// One-shot authoritative discovery: hit every provider key's GET /models
// endpoint and dump the live model-id list the key can actually see. Written
// 2026-07-12 for the honest-wiki rebuild — the source of truth for catalog
// reconciliation (dead ids out, missing ids in). GET-only: no completion
// tokens burned. Usage: npx tsx src/scripts/discover-models.ts
//
// The actual polling now lives in services/catalogDiscovery.ts (shared with the
// daily catalogSync reconciler); this stays a thin CLI wrapper that dumps the
// result to a file for eyeballing.
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { discoverLiveModels } from '../services/catalogDiscovery.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

async function main() {
  await initDb();
  const result = await discoverLiveModels(getPool());

  const out: Record<string, { status: number; count: number; ids: string[]; err?: string }> = {};
  for (const [platform, d] of Object.entries(result)) {
    out[platform] = { status: d.status, count: d.ids.length, ids: d.ids, err: d.err };
    console.log(`[${platform}] HTTP ${d.status} — ${d.ids.length} models${d.err ? ' ERR:' + d.err : ''}`);
  }

  // Stable, overridable output path (was a hardcoded per-session scratchpad dir
  // that no longer exists → ENOENT). Defaults to ./discovered-models.json in the
  // cwd (server/ when run via `npm run discover`), gitignored.
  const outPath = process.env.DISCOVER_OUT ?? path.resolve(process.cwd(), 'discovered-models.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
