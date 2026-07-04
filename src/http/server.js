import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import ingestRouter from './routes/ingest.js';
import { smsRouter } from './routes/sms.js';
import aiRouter from './routes/ai.js';
import accessTokensRouter from './routes/accessTokens.js';
import transactionsRouter from './routes/transactions.js';
import authRouter from './routes/auth.js';
import improvementsRouter from './routes/improvements.js';
import pushRouter from '../routes/push.js';

/**
 * Cree l'app Express. analysisService est injecte pour la route /sms/:id/reanalyze.
 *
 * @param {{ analysisService?: import('../analysis/service.js').SmsAnalysisService }} deps
 */
export function createApp({ analysisService } = {}) {
  const app = express();

  app.use(helmet());

  // CORS : ALLOWED_ORIGINS = liste virgule-separee, "*" pour tout autoriser (dev).
  const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  app.use(cors({
    origin: allowed.includes('*') ? true : allowed,
    credentials: false,
  }));

  app.use(express.json({ limit: '2mb' }));
  app.use(rateLimit({ windowMs: 60_000, max: 300 }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/auth', authRouter);
  app.use('/api', ingestRouter);

  // Dashboard (auth ADMIN_TOKEN, monte a la racine pour matcher le frontend qui
  // appelle /sms et /ai sans prefixe /api).
  if (analysisService) {
    app.use('/sms', smsRouter({ analysisService }));
  }
  app.use('/ai', aiRouter);
  app.use('/access-tokens', accessTokensRouter);
  app.use('/improvements', improvementsRouter);
  app.use('/api/transactions', transactionsRouter());
  app.use('/api/push', pushRouter);

  app.use((err, _req, res, _next) => {
    console.error('[http] erreur :', err.message);
    res.status(err.status || 500).json({ error: 'Erreur interne' });
  });

  return app;
}

/**
 * Demarre le serveur HTTP. No-op si ni INGEST_TOKEN ni ADMIN_TOKEN ne sont definis
 * (mode worker pur, retro-compatible).
 */
export function startServer({ analysisService } = {}) {
  if (!process.env.INGEST_TOKEN && !process.env.ADMIN_TOKEN) {
    console.log('[http] INGEST_TOKEN et ADMIN_TOKEN absents : serveur HTTP desactive');
    return null;
  }
  const port = Number(process.env.PORT || process.env.HTTP_PORT || 3001);
  const app = createApp({ analysisService });
  const server = app.listen(port, () => {
    console.log(`[http] serveur en ecoute sur :${port}`);
  });
  return server;
}
