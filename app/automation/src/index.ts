import express from 'express';
import cors from 'cors';
import { config } from './config/env';
import chatRoutes     from './routes/chat.routes';
import documentRoutes from './routes/document.routes';
import historyRoutes  from './routes/history.routes';
import adminRoutes    from './routes/admin.routes';
import quoteRoutes    from './routes/quote.routes';
import { browserPool } from './session/pool';

const app = express();

const corsOrigin = config.nodeEnv === 'development' ? '*' : config.frontendUrl;
app.use(cors({ origin: corsOrigin, credentials: config.nodeEnv !== 'development' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'alert-automation', env: config.nodeEnv, ts: new Date().toISOString() });
});

app.use('/api/chat',      chatRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/history',   historyRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/quotes',    quoteRoutes);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err?.message || err);
  res.status(err?.status || 500).json({ success: false, message: err?.message || 'Internal server error' });
});

const server = app.listen(config.port, () => {
  console.log(`\n🚀 Alert Automation Service on http://localhost:${config.port}`);
  console.log(`   ENV: ${config.nodeEnv}\n`);
});

async function shutdown() {
  server.close();
  await browserPool.shutdown();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

export default app;
