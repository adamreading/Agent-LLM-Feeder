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

async function main() {
  await initDb();
  const result = await discoverLiveModels(getPool());

  const out: Record<string, { status: number; count: number; ids: string[]; err?: string }> = {};
  for (const [platform, d] of Object.entries(result)) {
    out[platform] = { status: d.status, count: d.ids.length, ids: d.ids, err: d.err };
    console.log(`[${platform}] HTTP ${d.status} — ${d.ids.length} models${d.err ? ' ERR:' + d.err : ''}`);
  }

  const path = '/tmp/claude-1000/-home-ajo-Agent-LLM-Feeder/2fbd53c3-4337-4fed-bc4e-4a9d2a10ee4e/scratchpad/live-models.json';
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${path}`);
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
