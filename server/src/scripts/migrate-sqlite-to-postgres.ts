// One-shot data migration: copies every row from the existing SQLite database
// into the already-schema-migrated Postgres database, preserving primary keys
// (so foreign keys like fallback_config.model_db_id stay valid), then resets
// each table's serial sequence so future inserts don't collide.
//
// Idempotent-safe to re-run against an EMPTY Postgres database only — it does
// not upsert. Run once, as part of the P1 drain-and-flip cutover, after the
// server has stopped accepting new requests and in-flight requests drained.
import Database from 'better-sqlite3';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const SQLITE_PATH = path.resolve(__dirname, '../../data/freeapi.db');

function toTimestamp(sqliteDatetime: string | null): Date | null {
  if (!sqliteDatetime) return null;
  // SQLite's datetime('now') stores 'YYYY-MM-DD HH:MM:SS' in UTC with no
  // timezone marker — make that explicit before parsing.
  return new Date(sqliteDatetime.replace(' ', 'T') + 'Z');
}

async function main() {
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- models ---------------------------------------------------------
    const models = sqlite.prepare('SELECT * FROM models').all() as any[];
    for (const m of models) {
      await client.query(
        `INSERT INTO models
           (id, platform, model_id, display_name, intelligence_rank, speed_rank,
            size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
            monthly_token_budget, context_window, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          m.id, m.platform, m.model_id, m.display_name, m.intelligence_rank, m.speed_rank,
          m.size_label, m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit,
          m.monthly_token_budget, m.context_window, m.enabled === 1,
        ]
      );
    }

    // --- api_keys ---------------------------------------------------------
    const apiKeys = sqlite.prepare('SELECT * FROM api_keys').all() as any[];
    for (const k of apiKeys) {
      await client.query(
        `INSERT INTO api_keys
           (id, platform, label, encrypted_key, iv, auth_tag, status, enabled,
            created_at, last_checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          k.id, k.platform, k.label, k.encrypted_key, k.iv, k.auth_tag, k.status,
          k.enabled === 1, toTimestamp(k.created_at), toTimestamp(k.last_checked_at),
        ]
      );
    }

    // --- requests -----------------------------------------------------
    const requests = sqlite.prepare('SELECT * FROM requests').all() as any[];
    for (const r of requests) {
      await client.query(
        `INSERT INTO requests
           (id, platform, model_id, status, input_tokens, output_tokens, latency_ms,
            error, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          r.id, r.platform, r.model_id, r.status, r.input_tokens, r.output_tokens,
          r.latency_ms, r.error, toTimestamp(r.created_at),
        ]
      );
    }

    // --- fallback_config -----------------------------------------------
    const fallbackConfig = sqlite.prepare('SELECT * FROM fallback_config').all() as any[];
    for (const f of fallbackConfig) {
      await client.query(
        `INSERT INTO fallback_config (id, model_db_id, priority, enabled)
         VALUES ($1,$2,$3,$4)`,
        [f.id, f.model_db_id, f.priority, f.enabled === 1]
      );
    }

    // --- settings -----------------------------------------------------
    const settings = sqlite.prepare('SELECT * FROM settings').all() as any[];
    for (const s of settings) {
      await client.query(`INSERT INTO settings (key, value) VALUES ($1,$2)`, [s.key, s.value]);
    }

    // Migrate the single unified_api_key into consumer_keys as the 'fleet'
    // trust-tier row (L4 outer gate foundation — P2 wires enforcement).
    const unifiedKey = settings.find((s) => s.key === 'unified_api_key');
    if (unifiedKey) {
      const crypto = await import('crypto');
      const keyHash = crypto.createHash('sha256').update(unifiedKey.value).digest('hex');
      await client.query(
        `INSERT INTO consumer_keys (label, key_hash, trust_tier, enabled)
         VALUES ($1,$2,$3,$4)`,
        ['fleet', keyHash, 'fleet', true]
      );
    }

    // Reset serial sequences past the max copied id so future inserts don't collide.
    const sequenceTables = ['models', 'api_keys', 'requests', 'fallback_config'];
    for (const t of sequenceTables) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1))`,
        [t]
      );
    }

    await client.query('COMMIT');

    // --- row-count parity verification ---------------------------------
    const tables: Array<[string, number]> = [
      ['models', models.length],
      ['api_keys', apiKeys.length],
      ['requests', requests.length],
      ['fallback_config', fallbackConfig.length],
      ['settings', settings.length],
    ];
    let allMatch = true;
    for (const [table, sourceCount] of tables) {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
      const destCount = rows[0].count;
      const status = destCount === sourceCount ? 'OK' : 'MISMATCH';
      if (destCount !== sourceCount) allMatch = false;
      console.log(`${table}: sqlite=${sourceCount} postgres=${destCount} [${status}]`);
    }
    if (!allMatch) {
      throw new Error('Row-count parity check failed — see mismatches above');
    }
    console.log('\nMigration complete. Row-count parity verified.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
