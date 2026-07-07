// Test isolation helper: Postgres has no ":memory:" equivalent, so each test
// file that needs a fresh catalog gets its own disposable database — created
// from the same server as DATABASE_URL, migrated with the real schema SQL,
// and dropped on teardown. Mirrors the old better-sqlite3 `:memory:` isolation
// semantics (fresh catalog per file, no cross-file pollution).
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// Apply every migration file in order (0000, 0001, ...) — not just the
// first — so new test databases always reflect the current full schema.
const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');
const MIGRATION_FILES = fs.readdirSync(MIGRATIONS_DIR)
  .filter(f => f.endsWith('.sql'))
  .sort();
const MIGRATION_SQL = MIGRATION_FILES
  .map(f => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n--> statement-breakpoint\n');

function baseConnectionParts() {
  const url = new URL(process.env.DATABASE_URL!);
  return url;
}

export async function createTestDb(): Promise<{ connectionString: string; drop: () => Promise<void> }> {
  const base = baseConnectionParts();
  const dbName = `feeder_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  const adminUrl = new URL(base.toString());
  adminUrl.pathname = '/postgres';
  const admin = new pg.Pool({ connectionString: adminUrl.toString() });
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const testUrl = new URL(base.toString());
  testUrl.pathname = `/${dbName}`;
  const connectionString = testUrl.toString();

  const testPool = new pg.Pool({ connectionString });
  // drizzle-kit wraps each statement with a breakpoint marker; split on it.
  const statements = MIGRATION_SQL.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await testPool.query(stmt);
  }
  await testPool.end();

  const drop = async () => {
    const adminForDrop = new pg.Pool({ connectionString: adminUrl.toString() });
    // Terminate any lingering connections before dropping.
    await adminForDrop.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName]
    );
    await adminForDrop.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminForDrop.end();
  };

  return { connectionString, drop };
}
