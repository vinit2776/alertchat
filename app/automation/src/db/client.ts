import { Pool } from 'pg';
import { config } from '../config/env';

let _pool: Pool | null = null;

function isDbConfigured(): boolean {
  return !!config.databaseUrl;
}

export function getPool(): Pool {
  if (!_pool) {
    if (!isDbConfigured()) throw new Error('DATABASE_URL not set');
    _pool = new Pool({ connectionString: config.databaseUrl });
    _pool.on('error', (err) => {
      console.error('[DB] Unexpected pool error', err);
    });
  }
  return _pool;
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
