import 'dotenv/config';
import { pool } from './db.js';
import { SmsAnalysisService } from './analysis/service.js';
import { SmsAnalyzerRegistry } from './analysis/registry.js';
import { PromoSmsAnalyzer } from './analysis/providers/promo.js';
import { MtnSmsAnalyzer } from './analysis/providers/mtn.js';
import { AirtelSmsAnalyzer } from './analysis/providers/airtel.js';
import { AiSmsAnalyzer } from './analysis/providers/ai.js';
import { UnknownSmsAnalyzer } from './analysis/providers/unknown.js';
import { startServer } from './http/server.js';
import { syncTecnoNumbers } from './services/tecnoSync.service.js';
import { getTecnoSyncState } from './repos/setting.repo.js';
import { ensureAgentSchema } from './repos/agentSchema.repo.js';

// Worker pur : interroge la base A (table `sms`) toutes les POLL_INTERVAL_MS,
// analyse les SMS en status='received' et ecrit le resultat dans la base B (table `sms_analysis`).
// Pas d'HTTP, pas de WebSocket, pas de modem.

const {
  POLL_INTERVAL_MS = '5000',
  BATCH_SIZE = '50',
} = process.env;

const pollIntervalMs = Number(POLL_INTERVAL_MS);
const batchSize = Number(BATCH_SIZE);

const aiAnalyzer = new AiSmsAnalyzer();
const registry = new SmsAnalyzerRegistry([
  new PromoSmsAnalyzer(),        // EN PREMIER : court-circuite les SMS promo avant le LLM
  new MtnSmsAnalyzer(),
  new AirtelSmsAnalyzer(),
  aiAnalyzer,                    // canAnalyze=true si une cle AI est active
  new UnknownSmsAnalyzer(),      // fallback, doit etre en dernier
]);
const analysisService = new SmsAnalysisService({ pool, registry });

// Schema du module AGENT auto-applique au demarrage (Render lance `npm start`,
// pas `npm run migrate`). Idempotent : CREATE TABLE / ADD COLUMN IF NOT EXISTS.
await ensureAgentSchema();

// Rafraichit le flag canAnalyze de l'AI au demarrage puis toutes les 60s
await aiAnalyzer.refresh();
const aiRefreshTimer = setInterval(() => aiAnalyzer.refresh(), 60_000);
aiRefreshTimer.unref();

let stopping = false;
let tickInFlight = false;

async function tick() {
  if (stopping || tickInFlight) return;
  tickInFlight = true;
  try {
    await analysisService.analyzePending(batchSize);
  } catch (err) {
    console.error('[worker] tick echec :', err.message);
  } finally {
    tickInFlight = false;
  }
}

console.log(`[worker] demarrage : poll toutes les ${pollIntervalMs}ms, batch=${batchSize}`);
await tick(); // premiere passe immediate
const pollTimer = setInterval(tick, pollIntervalMs);

// Serveur HTTP (ingestion PDV + dashboard admin) — actif si au moins un token defini.
const httpServer = startServer({ analysisService });

// ---- Synchro TECNO « Tecno Ya Niongo » (cron interne) ----
// Active seulement si une cle partenaire est definie et TECNO_SYNC_ENABLED != 'false'.
const tecnoTimers = [];
if (process.env.TECNO_PARTNER_API_KEY && process.env.TECNO_SYNC_ENABLED !== 'false') {
  const incrementalMs = Number(process.env.TECNO_SYNC_INTERVAL_MS || 900_000);      // 15 min
  const fullMs = Number(process.env.TECNO_SYNC_FULL_INTERVAL_MS || 86_400_000);     // 24 h

  const runSync = async (mode) => {
    try { await syncTecnoNumbers({ mode }); }
    catch (err) { /* deja logge/alerte dans le service */ void err; }
  };

  // Amorcage : full si jamais synchronise, sinon incremental immediat.
  const state = await getTecnoSyncState();
  await runSync(state.lastSuccessAt ? 'incremental' : 'full');

  const incrementalTimer = setInterval(() => runSync('incremental'), incrementalMs);
  incrementalTimer.unref();
  const fullTimer = setInterval(() => runSync('full'), fullMs);
  fullTimer.unref();
  tecnoTimers.push(incrementalTimer, fullTimer);
  console.log(`[tecno-sync] planifie : incremental ${incrementalMs}ms, resync plein ${fullMs}ms`);
} else {
  console.log('[tecno-sync] desactive (TECNO_PARTNER_API_KEY absent ou TECNO_SYNC_ENABLED=false)');
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[worker] ${signal} recu, arret...`);
  clearInterval(pollTimer);
  clearInterval(aiRefreshTimer);
  for (const t of tecnoTimers) clearInterval(t);
  if (httpServer) {
    await new Promise((r) => httpServer.close(() => r()));
  }
  // Laisser le tick en cours se terminer
  while (tickInFlight) await new Promise((r) => setTimeout(r, 100));
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
