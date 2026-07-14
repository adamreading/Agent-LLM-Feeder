// Add the free CHAT-model candidates (free-chat.json) to the catalog as
// enabled=false / pending-liveness. Skips any (platform, model_id) already
// present. A later liveness pass flips WORKS→enabled=true; models that error
// with payment/subscription-required or 404 stay disabled. This keeps untested
// models out of routing and the wiki until proven. Usage:
//   npx tsx src/scripts/add-free-models.ts
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, get, run } from '../db/pgCompat.js';
import { classifyModelKind } from '../services/modelKind.js';
import { readFileSync } from 'node:fs';

function titleCase(id: string): string {
  const leaf = (id.split('/').pop() ?? id).replace(/:free$/, '');
  return leaf.replace(/[-_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

async function main() {
  await initDb();
  const perProv = JSON.parse(readFileSync('/tmp/claude-1000/-home-ajo-Agent-LLM-Feeder/2fbd53c3-4337-4fed-bc4e-4a9d2a10ee4e/scratchpad/free-chat.json', 'utf8'));
  let added = 0, skipped = 0;
  const addedByProv: Record<string, number> = {};

  for (const [platform, info] of Object.entries<any>(perProv)) {
    for (const modelId of info.chatIds ?? []) {
      const existing = await get<{ id: number }>(getPool(),
        `SELECT id FROM models WHERE platform=? AND model_id=?`, [platform, modelId]);
      if (existing) { skipped++; continue; }
      await run(getPool(), `
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, cost_tier, disabled_reason, match_status, kind)
        VALUES (?, ?, ?, 500, 500, false, 'free', 'pending-liveness (free-sweep 2026-07-12)', 'unmatched', ?)
      `, [platform, modelId, titleCase(modelId), classifyModelKind(modelId, titleCase(modelId))]);
      added++;
      addedByProv[platform] = (addedByProv[platform] ?? 0) + 1;
    }
  }
  console.log('Added per provider:', JSON.stringify(addedByProv, null, 2));
  console.log(`\nTOTAL added: ${added}  |  skipped (already in catalog): ${skipped}`);
  const counts = await all<{ enabled: boolean; c: string }>(getPool(), `SELECT enabled, count(*) c FROM models GROUP BY enabled`);
  console.log('models table now:', counts.map(r => `${r.enabled ? 'enabled' : 'disabled'}=${r.c}`).join('  '));
  await closeDb();
}
main().catch(e => { console.error(e); process.exit(1); });
