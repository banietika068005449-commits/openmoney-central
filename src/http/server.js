import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import ingestRouter from './routes/ingest.js';

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: '2mb' }));
  app.use(rateLimit({ windowMs: 60_000, max: 300 }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api', ingestRouter);

  // Gestionnaire d'erreur final.
  app.use((err, _req, res, _next) => {
    console.error('[http] erreur :', err.message);
    res.status(err.status || 500).json({ error: 'Erreur interne' });
  });

  return app;
}

/**
 * Demarre le serveur HTTP d'ingestion. No-op si INGEST_TOKEN n'est pas defini
 * (mode worker pur, retro-compatible).
 */
export function startServer() {
  if (!process.env.INGEST_TOKEN) {
    console.log('[http] INGEST_TOKEN absent : endpoint HTTP desactive');
    return null;
  }
  // Render/Heroku/etc imposent PORT, on garde HTTP_PORT comme override local.
  const port = Number(process.env.PORT || process.env.HTTP_PORT || 3001);
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`[http] ingestion HTTP en ecoute sur :${port}`);
  });
  return server;
}
