import { Pool } from 'pg';
import { config } from '../config/env';

let _pool: Pool | null = null;

function isDbConfigured(): boolean {
  return !!config.databaseUrl;
}

export function getPool(): Pool {
  if (!_pool) {
    if (!isDbConfigured()) throw new Error('DATABASE_URL not set');
    _pool = new Pool({
      connectionString: config.databaseUrl,
      // Bounded pool — prevents "remaining connection slots are reserved"
      // under spike. Railway Postgres allows ~50 connections; reserve 5 for
      // admin/migrations, give ourselves 20, leave headroom for multi-instance.
      max:                     20,
      // Recycle idle conns every 30s so we don't sit on stale ones
      idleTimeoutMillis:       30_000,
      // Fail fast if Postgres is overloaded
      connectionTimeoutMillis: 5_000,
      // Cap each query at 30s — anything slower is a bug
      statement_timeout:       30_000,
    });
    _pool.on('error', (err) => {
      console.error('[DB] Unexpected pool error', err);
    });
  }
  return _pool;
}

/** Close the pool gracefully — call from SIGTERM handler. */
export async function closePool(): Promise<void> {
  if (_pool) {
    try { await _pool.end(); } catch (err) { console.error('[DB] pool.end() failed:', err); }
    _pool = null;
  }
}

export async function query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
  if (!isDbConfigured()) return [];
  const pool = getPool();
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}

export async function queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}
