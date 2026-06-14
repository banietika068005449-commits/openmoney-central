import { test, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { pool, insertSms } from '../db.js';
import { SmsAnalysisService } from './service.js';
import { SmsAnalyzerRegistry } from './registry.js';
import { MtnSmsAnalyzer } from './providers/mtn.js';
import { AirtelSmsAnalyzer } from './providers/airtel.js';
import { UnknownSmsAnalyzer } from './providers/unknown.js';

// Filtre de nettoyage : tous les SMS de test partagent ce sender.
const TEST_SENDER = '+99TEST';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const registry = new SmsAnalyzerRegistry([
  new MtnSmsAnalyzer(),
  new AirtelSmsAnalyzer(),
  new UnknownSmsAnalyzer(),
]);
const service = new SmsAnalysisService({ pool, registry, logger: silentLogger });

async function cleanup() {
  // sms_analysis disparait via ON DELETE CASCADE
  await pool.query(`DELETE FROM sms WHERE sender = $1`, [TEST_SENDER]);
}

beforeEach(cleanup);
after(async () => { await cleanup(); await pool.end(); });

async function insertTestSms(content) {
  return insertSms({
    sender: TEST_SENDER,
    content,
    smscTs: new Date(),
    modemIndex: 0,
    raw: 'test',
  });
}

test('analyzeOne : insere une ligne sms_analysis et passe sms.status=analyzed', async () => {
  const sms = await insertTestSms('MTN MoMo: Vous avez recu 10 000 FCFA de +242066123456. Solde: 25 000 FCFA. Ref: ABC123');
  const r = await service.analyzeOne(sms.id);

  assert.ok(r);
  // r.provider et r.smsType sont toujours calcules en interne par les analyseurs ;
  // ils ne sont juste plus persistes dans sms_analysis (depuis 2026-06).
  assert.equal(r.provider, 'mtn-sms-analyzer');
  assert.equal(r.smsType, 'money_received');
  assert.equal(r.amount, 10000);
  assert.equal(r.balance, 25000);

  const { rows: [smsRow] } = await pool.query(`SELECT status FROM sms WHERE id=$1`, [sms.id]);
  assert.equal(smsRow.status, 'analyzed');

  const { rows: [aRow] } = await pool.query(
    `SELECT amount, balance, currency, phone_number, reference, analysis_status
     FROM sms_analysis WHERE sms_id=$1`,
    [sms.id],
  );
  assert.equal(Number(aRow.amount), 10000);
  assert.equal(Number(aRow.balance), 25000);
  assert.equal(aRow.currency, 'FCFA');
  assert.equal(aRow.phone_number, '+242066123456');
  assert.equal(aRow.reference, 'ABC123');
  assert.equal(aRow.analysis_status, 'success');
});

test('analyzeOne : SMS sans info utile -> status=ignored, analysis_status=ignored', async () => {
  const sms = await insertTestSms('Bonjour votre forfait internet expire demain.');
  const r = await service.analyzeOne(sms.id);

  assert.equal(r.analysisStatus, 'ignored');

  const { rows: [smsRow] } = await pool.query(`SELECT status FROM sms WHERE id=$1`, [sms.id]);
  assert.equal(smsRow.status, 'ignored');

  const { rows: [aRow] } = await pool.query(
    `SELECT analysis_status FROM sms_analysis WHERE sms_id=$1`,
    [sms.id],
  );
  assert.equal(aRow.analysis_status, 'ignored');
});

test('analyzeOne : idempotent (rejouer ne cree pas de doublon)', async () => {
  const sms = await insertTestSms('Airtel Money: Solde actuel: 75 000 FCFA');
  await service.analyzeOne(sms.id);

  // 2eme passage : sms.status est deja 'analyzed', SELECT FOR UPDATE renvoie 0 ligne -> null
  const second = await service.analyzeOne(sms.id);
  assert.equal(second, null);

  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM sms_analysis WHERE sms_id=$1`, [sms.id]);
  assert.equal(rows[0].n, 1);
});

test('analyzeOne : erreur dans provider -> rollback + sms.status=failed', async () => {
  const sms = await insertTestSms('MTN MoMo: test rollback');

  // Provider qui jette une erreur
  const brokenProvider = {
    name: 'broken',
    canAnalyze: () => true,
    analyze: async () => { throw new Error('boom'); },
  };
  const brokenRegistry = new SmsAnalyzerRegistry([brokenProvider]);
  const brokenService = new SmsAnalysisService({ pool, registry: brokenRegistry, logger: silentLogger });

  await assert.rejects(() => brokenService.analyzeOne(sms.id), /boom/);

  const { rows: [smsRow] } = await pool.query(`SELECT status FROM sms WHERE id=$1`, [sms.id]);
  assert.equal(smsRow.status, 'failed');

  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM sms_analysis WHERE sms_id=$1`, [sms.id]);
  assert.equal(rows[0].n, 0);
});

test('analyzePending : reprend les SMS en status=received', async () => {
  const a = await insertTestSms('MTN MoMo: Vous avez recu 1 000 FCFA');
  const b = await insertTestSms('Airtel Money: paiement de 2 000 FCFA');
  // Les deux ont par defaut status='received' (cf. schema).
  const res = await service.analyzePending(50);
  assert.ok(res.processed >= 2, `processed=${res.processed}`);

  const { rows } = await pool.query(
    `SELECT id, status FROM sms WHERE id IN ($1,$2) ORDER BY id`,
    [a.id, b.id],
  );
  for (const r of rows) {
    assert.ok(r.status === 'analyzed' || r.status === 'ignored', `status inattendu: ${r.status}`);
  }
});
