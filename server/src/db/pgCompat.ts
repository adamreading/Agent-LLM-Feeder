import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

// Translates SQLite-style `?` positional placeholders to Postgres `$1, $2, ...`
// so the existing body of parameterized SQL (seed/migration history, route
// queries) ports without hand-renumbering every statement — the source of
// most transcription risk in a mechanical dialect port.
function toPgSql(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export async function run(client: Queryable, sql: string, params: any[] = []): Promise<{ changes: number }> {
  const result = await client.query(toPgSql(sql), params);
  return { changes: result.rowCount ?? 0 };
}

export async function runReturningId(client: Queryable, sql: string, params: any[] = []): Promise<number> {
  const result = await client.query(toPgSql(sql) + ' RETURNING id', params);
  return result.rows[0].id;
}

export async function all<T = any>(client: Queryable, sql: string, params: any[] = []): Promise<T[]> {
  const result = await client.query(toPgSql(sql), params);
  return result.rows as T[];
}

export async function get<T = any>(client: Queryable, sql: string, params: any[] = []): Promise<T | undefined> {
  const result = await client.query(toPgSql(sql), params);
  return result.rows[0] as T | undefined;
}

// Runs `fn` inside a BEGIN/COMMIT transaction on a dedicated client checked
// out from the pool — mirrors better-sqlite3's db.transaction(fn) semantics
// (all-or-nothing) for the seed/migration functions that rely on it.
export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
