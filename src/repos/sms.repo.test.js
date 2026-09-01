import { after, beforeEach, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';

import { pool } from '../db.js';
import { listSms } from './sms.repo.js';

const TEST_SENDER = '+99ADMINFILTER';
const TEST_PDV = 'ADMIN_FILTER_TEST';

async function cleanup() {
  await pool.query(
    `DELETE FROM sms
     WHERE sender = $1
        OR point_de_vente = $2
        OR content ILIKE '%ADMIN_FILTER_%'`,
    [TEST_SENDER, TEST_PDV],
  );
}

beforeEach(cleanup);
after(async () => {
  await cleanup();
  await pool.end();
});

async function insertTestSms({ content, sender = TEST_SENDER, pointDeVente = TEST_PDV } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO sms (uuid, sender, content, smsc_ts, raw, status, point_de_vente)
     VALUES ($1, $2, $3, NOW(), $4, 'admin_filter_test', $5)
     RETURNING id, uuid`,
    [randomUUID(), sender, content, 'admin-filter-test', pointDeVente],
  );
  return rows[0];
}

async function insertAnalysis(smsId, {
  operator = 'MTN',
  amount = 10000,
  currency = 'FCFA',
  phoneNumber = '066123456',
  reference = 'REF-ADMIN-FILTER',
  transactionId = 'TX-ADMIN-FILTER',
} = {}) {
  await pool.query(
    `INSERT INTO sms_analysis
       (sms_id, operator, amount, currency, phone_number, reference, transaction_id, extracted_data, analysis_status, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, 'success', NULL)`,
    [smsId, operator, amount, currency, phoneNumber, reference, transactionId],
  );
}

function hasSms(result, smsId) {
  return (result.items || []).some((item) => Number(item.id) === Number(smsId));
}

test('listSms: q retrouve une trame brute recue sans sms_analysis', async () => {
  const marker = `ADMIN_FILTER_RAW_Q_${Date.now()}`;
  const sms = await insertTestSms({
    content: `Trame brute API ${marker} client 055 998 877.`,
  });

  const result = await listSms({ limit: 10, offset: 0, q: marker, sort: 'recent' });

  assert.ok(hasSms(result, sms.id), 'la trame brute doit apparaitre dans la recherche admin');
});

test('listSms: phone cherche aussi dans sender/content normalises', async () => {
  const sms = await insertTestSms({
    content: 'ADMIN_FILTER_PHONE paiement recu du client 055 998 877.',
  });

  const result = await listSms({ limit: 10, offset: 0, phone: '055998877', sort: 'recent' });

  assert.ok(hasSms(result, sms.id), 'le numero doit etre retrouve meme sans ligne sms_analysis');
});

test('listSms: transactionId a un fallback sur le contenu brut et uuid', async () => {
  const transactionId = `ADMIN_FILTER_TX_${Date.now()}`;
  const sms = await insertTestSms({
    content: `Notification API avec transaction ${transactionId}.`,
  });

  const byContent = await listSms({ limit: 10, offset: 0, transactionId, sort: 'recent' });
  const byUuid = await listSms({ limit: 10, offset: 0, transactionId: String(sms.uuid), sort: 'recent' });

  assert.ok(hasSms(byContent, sms.id), 'transactionId doit retrouver une transaction mentionnee dans le SMS brut');
  assert.ok(hasSms(byUuid, sms.id), 'transactionId doit retrouver une trame brute par uuid');
});

test('listSms: les filtres analyses continuent de fonctionner avec sms_analysis', async () => {
  const marker = `ADMIN_FILTER_ANALYZED_${Date.now()}`;
  const transactionId = `TX-${marker}`;
  const sms = await insertTestSms({ content: `Transaction analysee ${marker}` });
  await insertAnalysis(sms.id, {
    operator: 'MTN',
    amount: 10000,
    phoneNumber: '066123456',
    transactionId,
  });

  const byPhone = await listSms({ limit: 10, offset: 0, phone: '066123456', sort: 'recent' });
  const byTransaction = await listSms({ limit: 10, offset: 0, transactionId, sort: 'recent' });
  const byAmount = await listSms({ limit: 10, offset: 0, q: marker, amount: 1000000, sort: 'recent' });

  assert.ok(hasSms(byPhone, sms.id), 'phone doit conserver le comportement via sms_analysis');
  assert.ok(hasSms(byTransaction, sms.id), 'transactionId doit conserver le comportement exact via sms_analysis');
  assert.ok(hasSms(byAmount, sms.id), 'amount doit continuer a filtrer les lignes analysees');
});

test('listSms: operatorPrefix reste limite aux donnees analysees', async () => {
  const marker = `ADMIN_FILTER_OPERATOR_${Date.now()}`;
  const sms = await insertTestSms({
    content: `${marker} client 061234567 sans analyse.`,
  });

  const result = await listSms({ limit: 10, offset: 0, q: marker, operatorPrefix: 'MTN', sort: 'recent' });

  assert.equal(hasSms(result, sms.id), false);
  assert.equal(result.total, 0);
});
