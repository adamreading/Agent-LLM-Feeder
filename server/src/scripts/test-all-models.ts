/**
 * Probe every enabled model with a minimal request to find broken model IDs.
 * Usage: npx tsx src/scripts/test-all-models.ts
 */
import { initDb, getPool } from '../db/index.js';
import { all, get } from '../db/pgCompat.js';
import { decrypt } from '../lib/crypto.js';
import { getProvider } from '../providers/index.js';

await initDb();
const pool = getPool();

interface Row {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
}
interface Key {
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}

const models = await all<Row>(pool, `
  SELECT m.id, m.platform, m.model_id, m.display_name
    FROM models m
   WHERE m.enabled = true
     AND EXISTS (SELECT 1 FROM api_keys k WHERE k.platform = m.platform AND k.enabled = true)
   ORDER BY m.intelligence_rank, m.platform
`);

const results: { row: Row; ok: boolean; ms: number; error?: string; reply?: string }[] = [];

for (const row of models) {
  const keyRow = await get<Key>(pool, `
    SELECT encrypted_key, iv, auth_tag FROM api_keys
     WHERE platform = ? AND enabled = true ORDER BY id LIMIT 1
  `, [row.platform]);
  if (!keyRow) { results.push({ row, ok: false, ms: 0, error: 'no key' }); continue; }
  const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
  const provider = getProvider(row.platform as any);
  if (!provider) { results.push({ row, ok: false, ms: 0, error: 'no provider' }); continue; }

  const start = Date.now();
  try {
    const res = await provider.chatCompletion(apiKey, [{ role: 'user', content: 'hi' }], row.model_id, { max_tokens: 5 });
    const reply = res.choices?.[0]?.message?.content?.slice(0, 40) ?? '';
    results.push({ row, ok: true, ms: Date.now() - start, reply });
  } catch (err: any) {
    results.push({ row, ok: false, ms: Date.now() - start, error: String(err?.message ?? err).slice(0, 200) });
  }
}

console.log('\n=== Results ===\n');
const pad = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
for (const r of results) {
  const status = r.ok ? '✓' : '✗';
  console.log(`${status} ${pad(r.row.platform, 12)} ${pad(r.row.model_id, 52)} ${String(r.ms).padStart(5)}ms  ${r.ok ? `"${r.reply}"` : r.error}`);
}
const okCount = results.filter(r => r.ok).length;
console.log(`\n${okCount}/${results.length} models working\n`);

process.exit(0);
