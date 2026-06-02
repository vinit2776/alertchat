import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { config } from './config/env';
import authRoutes     from './routes/auth.routes';
import chatRoutes     from './routes/chat.routes';
import documentRoutes from './routes/document.routes';
import historyRoutes  from './routes/history.routes';
import adminRoutes    from './routes/admin.routes';
import quoteRoutes    from './routes/quote.routes';
import usersRoutes    from './routes/users.routes';
import wizardRoutes   from './routes/wizard.routes';
import { globalLimit, loginLimit, uploadLimit, quoteLimit, wizardLimit } from './middleware/rate-limit';
import { browserPool } from './session/pool';
import { query, queryOne, closePool } from './db/client';
import { startSweeper as startSessionSweeper, stopSweeper as stopSessionSweeper } from './session/session-store';
import { startPendingActionsSweeper, stopPendingActionsSweeper } from './session/pending-actions';
import { shutdownLangfuse, tracingEnabled } from './ai/langfuse-client';

const app = express();

// Support comma-separated list in FRONTEND_URL so Vercel + Railway can both connect
const allowedOrigins = config.nodeEnv === 'development'
  ? true  // allow any origin in dev
  : config.frontendUrl.split(',').map(u => u.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins,
  credentials: config.nodeEnv !== 'development',
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// /health is intentionally unrate-limited so Railway healthchecks keep working
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'alert-automation', env: config.nodeEnv, ts: new Date().toISOString() });
});

// Trust the X-Forwarded-For header set by Railway's proxy so rate-limiting
// keys by the real client IP, not the proxy's IP.
app.set('trust proxy', 1);

// ── Apply rate limits per route ─────────────────────────────────────────
// Specific limits applied first; globalLimit catches anything not covered.
app.use('/api/auth/login', loginLimit);
app.use('/api/documents/upload', uploadLimit);
app.use('/api/quotes/:sessionId/start', quoteLimit);
app.use('/api/quotes/:sessionId/proceed', quoteLimit);
app.use('/api/wizard',    wizardLimit);
app.use(globalLimit);

app.use('/api/auth',      authRoutes);
app.use('/api/users',     usersRoutes);
app.use('/api/chat',      chatRoutes);
app.use('/api/wizard',    wizardRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/history',   historyRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/quotes',    quoteRoutes);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err?.message || err);
  res.status(err?.status || 500).json({ success: false, message: err?.message || 'Internal server error' });
});

// ── Seed default super_admin if no users exist ─────────────────────────────
async function seedDefaultAdmin(): Promise<void> {
  try {
    const row = await queryOne<{ count: string }>('SELECT COUNT(*) AS count FROM app_users');
    if (row && parseInt(row.count) === 0) {
      const hash = await bcrypt.hash('admin123', 10);
      await query(
        `INSERT INTO app_users (username, email, password_hash, role)
         VALUES ($1, $2, $3, $4)`,
        ['admin', 'admin@alertinsurance.in', hash, 'super_admin'],
      );
      console.log('[seed] Default super_admin created  →  admin / admin123');
      console.log('[seed] ⚠️  Change this password immediately via User Management');
    }
  } catch (err: any) {
    // Table may not exist yet (DB not configured) — safe to ignore
    if (!err.message?.includes('relation "app_users" does not exist')) {
      console.error('[seed] Failed to seed admin:', err.message);
    }
  }
}

const server = app.listen(config.port, async () => {
  console.log(`\n🚀 Alert Automation Service on http://localhost:${config.port}`);
  console.log(`   ENV: ${config.nodeEnv}`);
  console.log(`   Langfuse tracing: ${tracingEnabled ? 'enabled' : 'disabled'}\n`);
  await seedDefaultAdmin();

  // Start background sweepers — keep memory bounded over long uptimes
  startSessionSweeper();
  startPendingActionsSweeper();   // DB-backed now — no in-process state to release
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${signal} received — closing gracefully…`);

  stopSessionSweeper();
  stopPendingActionsSweeper();

  // Stop accepting new HTTP requests
  server.close(() => console.log('[shutdown] HTTP server closed'));

  // Race a 10s deadline so we don't hang forever
  const cleanup = Promise.all([
    browserPool.shutdown().catch(e => console.error('[shutdown] browserPool:', e)),
    closePool().catch(e => console.error('[shutdown] DB pool:', e)),
    tracingEnabled ? shutdownLangfuse() : Promise.resolve(),
  ]);
  const deadline = new Promise<void>(r => setTimeout(() => r(), 10_000));
  await Promise.race([cleanup, deadline]);

  console.log('[shutdown] done');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

export default app;
