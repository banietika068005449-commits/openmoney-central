import 'dotenv/config';
import { pool } from './db.js';
import { SmsAnalysisService } from './analysis/service.js';
import { SmsAnalyzerRegistry } from './analysis/registry.js';
import { MtnSmsAnalyzer } from './analysis/providers/mtn.js';
import { AirtelSmsAnalyzer } from './analysis/providers/airtel.js';
import { AiSmsAnalyzer } from './analysis/providers/ai.js';
import { UnknownSmsAnalyzer } from './analysis/providers/unknown.js';
import { startServer } from './http/server.js';

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
  new MtnSmsAnalyzer(),
  new AirtelSmsAnalyzer(),
  aiAnalyzer,                    // canAnalyze=true si une cle AI est active
  new UnknownSmsAnalyzer(),      // fallback, doit etre en dernier
]);
const analysisService = new SmsAnalysisService({ pool, registry });

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

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[worker] ${signal} recu, arret...`);
  clearInterval(pollTimer);
  clearInterval(aiRefreshTimer);
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
