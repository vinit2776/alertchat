import express from 'express';
import cors from 'cors';
import { config } from './config/env';
import { errorHandler } from './middleware/errorHandler';

import authRoutes from './routes/auth.routes';
import questionsRoutes from './routes/questions.routes';
import quotationRoutes from './routes/quotation.routes';
import documentRoutes from './routes/document.routes';
import policyRoutes from './routes/policy.routes';
import chatRoutes from './routes/chat.routes';

const app = express();

// Allow frontend URL + mobile clients in development
const corsOrigin = config.nodeEnv === 'development' ? '*' : config.frontendUrl;
app.use(cors({ origin: corsOrigin, credentials: config.nodeEnv !== 'development' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', env: config.nodeEnv, timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/auth',      authRoutes);
app.use('/api/questions', questionsRoutes);
app.use('/api/quotation', quotationRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/policy',    policyRoutes);
app.use('/api/chat',      chatRoutes);

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`\n🚀 CHI Integration Server running on http://localhost:${config.port}`);
  console.log(`   ENV: ${config.nodeEnv}`);
  console.log(`   CHI Base URL: ${config.chi.baseUrl}\n`);
});

export default app;
