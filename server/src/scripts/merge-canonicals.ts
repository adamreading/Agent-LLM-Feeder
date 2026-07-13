// Merge snapshot/date-variant canonicals into one page per model (Adam,
// 2026-07-13). Groups ALL models by the (now snapshot-stripping)
// normalizeModelId; for any group spanning >1 canonical, repoints every
// instance to a survivor, renames the survivor to a clean base name, moves the
// survivor's alias to the merged key, and deletes the emptied canonicals
// (+ their task_scores/aliases). Idempotent. Usage:
//   npx tsx src/scripts/merge-canonicals.ts
import '../env.js';
import { initDb, closeDb, getPool } from '../db/index.js';
import { all, get, run, transaction } from '../db/pgCompat.js';
import { normalizeModelId } from '../services/modelCanon.js';

function cleanName(modelId: string): string {
  const leaf = (modelId.split('/').pop() ?? modelId).replace(/:free$/, '');
  const isDate = (t: string) => /^\d{8}$/.test(t) || (/^\d{6}$/.test(t) && +t.slice(4) >= 1 && +t.slice(4) <= 12) || (/^\d{4}$/.test(t) && +t.slice(0, 2) >= 24 && +t.slice(0, 2) <= 27 && +t.slice(2) >= 1 && +t.slice(2) <= 12);
  const segs = leaf.split(/[-.]/);
  while (segs.length > 1) { const l = segs[segs.length - 1]; if (l === 'latest' || l === 'preview' || isDate(l)) segs.pop(); else break; }
  return segs.join(' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

async function main() {
  await initDb();
  const models = await all<{ id: number; platform: string; model_id: string; canonical_model_id: number | null }>(getPool(),
    `SELECT id, platform, model_id, canonical_model_id FROM models WHERE canonical_model_id IS NOT NULL`);

  const groups = new Map<string, { models: typeof models; canonicals: Set<number>; sample: string }>();
  for (const m of models) {
    const k = normalizeModelId(m.model_id);
    if (!groups.has(k)) groups.set(k, { models: [], canonicals: new Set(), sample: m.model_id });
    const g = groups.get(k)!;
    g.models.push(m); g.canonicals.add(m.canonical_model_id!);
    if (m.model_id.length < g.sample.length) g.sample = m.model_id;
  }

  let mergedGroups = 0, deletedCanonicals = 0;
  for (const [key, g] of groups) {
    if (g.canonicals.size <= 1) continue;
    const ids = [...g.canonicals];
    // survivor: prefer one with a summary (keep researched content), else lowest id
    const withSummary = await all<{ id: number }>(getPool(),
      `SELECT id FROM canonical_models WHERE id = ANY(?::int[]) AND summary IS NOT NULL AND summary <> '' ORDER BY id LIMIT 1`, [ids]);
    const survivor = withSummary[0]?.id ?? Math.min(...ids);
    const losers = ids.filter((i) => i !== survivor);

    await transaction(getPool(), async (client) => {
      // repoint every instance in this group to survivor
      await run(client, `UPDATE models SET canonical_model_id = ? WHERE id = ANY(?::int[])`, [survivor, g.models.map((m) => m.id)]);
      // clean the survivor's display name
      await run(client, `UPDATE canonical_models SET name = ?, updated_at = now() WHERE id = ?`, [cleanName(g.sample), survivor]);
      // move task_scores off losers that survivor lacks (dedup by task_type), then drop the rest
      for (const loser of losers) {
        await run(client, `
          UPDATE task_scores t SET canonical_model_id = ?
          WHERE t.canonical_model_id = ?
            AND NOT EXISTS (SELECT 1 FROM task_scores s WHERE s.canonical_model_id = ? AND s.task_type = t.task_type)
        `, [survivor, loser, survivor]);
        await run(client, `DELETE FROM task_scores WHERE canonical_model_id = ?`, [loser]);
        await run(client, `DELETE FROM canonical_model_aliases WHERE canonical_model_id = ?`, [loser]);
        await run(client, `DELETE FROM canonical_models WHERE id = ?`, [loser]);
        deletedCanonicals++;
      }
      // ensure survivor owns the merged alias key
      await run(client, `DELETE FROM canonical_model_aliases WHERE alias_key = ?`, [key]);
      await run(client, `INSERT INTO canonical_model_aliases (canonical_model_id, alias_key) VALUES (?, ?) ON CONFLICT (alias_key) DO UPDATE SET canonical_model_id = EXCLUDED.canonical_model_id`, [survivor, key]);
    });
    mergedGroups++;
    console.log(`[merged] ${cleanName(g.sample).padEnd(28)} <- ${ids.length} canonicals (${losers.length} deleted); ${g.models.length} instances`);
  }

  console.log(`\nMerged ${mergedGroups} groups, deleted ${deletedCanonicals} canonicals.`);
  const after = await get<{ total: string; visible: string }>(getPool(), `
    SELECT (SELECT count(*) FROM canonical_models) AS total,
           (SELECT count(DISTINCT c.id) FROM canonical_models c JOIN models m ON m.canonical_model_id=c.id WHERE m.enabled=true) AS visible`);
  console.log(`canonical_models total=${after?.total}  wiki-visible(enabled)=${after?.visible}`);
  await closeDb();
}
main().catch(e => { console.error(e); process.exit(1); });
