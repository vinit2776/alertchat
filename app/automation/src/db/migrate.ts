import fs from 'fs';
import path from 'path';
import { getPool } from './client';
import '../config/env';  // load dotenv

async function migrate() {
  const pool = getPool();
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`[migrate] Running ${file}…`);
    await pool.query(sql);
    console.log(`[migrate] ${file} done`);
  }

  console.log('[migrate] All migrations complete');
  await pool.end();
}

migrate().catch(err => {
  console.error('[migrate] Failed:', err);
  process.exit(1);
});
