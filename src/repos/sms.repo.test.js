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

test('listSms: q retrouve les identifiants analyses avec casse et format de numero differents', async () => {
  const marker = `REF-SEARCH-${Date.now()}`;
  const sms = await insertTestSms({ content: 'Transaction analysee pour la recherche par identifiant.' });
  await insertAnalysis(sms.id, {
    phoneNumber: '06 612 34 56',
    reference: marker,
    transactionId: `TX-${marker}`,
  });

  const byInternationalPhone = await listSms({ limit: 10, offset: 0, q: '+242 06 612-34-56', sort: 'recent' });
  const byReference = await listSms({ limit: 10, offset: 0, q: marker.toLowerCase().slice(4), sort: 'recent' });
  const byUuid = await listSms({ limit: 10, offset: 0, q: String(sms.uuid).toUpperCase(), sort: 'recent' });
  const bySmsId = await listSms({ limit: 10, offset: 0, q: String(sms.id), sort: 'recent' });

  assert.ok(hasSms(byInternationalPhone, sms.id), 'le numero international doit retrouver le numero local formate');
  assert.ok(hasSms(byReference, sms.id), 'une reference partielle doit etre insensible a la casse');
  assert.ok(hasSms(byUuid, sms.id), 'un UUID complet doit identifier la trame');
  assert.ok(hasSms(bySmsId, sms.id), 'un identifiant SMS numerique doit identifier la trame');
});

test('listSms: q reste limite aux identifiants et au fallback de la trame brute', async () => {
  const marker = `NON_IDENTIFIER_${Date.now()}`;
  const contentMarker = `CONTENUSEULEMENT${randomUUID().replace(/[^a-f]/gi, '').toUpperCase()}`;
  const amount = 800_000 + Math.floor(Math.random() * 100_000);
  const sms = await insertTestSms({
    content: 'Transaction analysee sans le marqueur reserve aux champs exclus.',
    pointDeVente: marker,
  });
  await insertAnalysis(sms.id, { amount });
  await pool.query(
    `INSERT INTO sms_note (sms_id, note) VALUES ($1, $2)
     ON CONFLICT (sms_id) DO UPDATE SET note = EXCLUDED.note`,
    [sms.id, marker],
  );
  const contentOnlySms = await insertTestSms({ content: `Description ordinaire ${contentMarker}.` });

  const byPointOfSale = await listSms({ limit: 10, offset: 0, q: marker, sort: 'recent' });
  const byAmount = await listSms({ limit: 10, offset: 0, q: String(amount), sort: 'recent' });
  const byOrdinaryContent = await listSms({ limit: 10, offset: 0, q: contentMarker, sort: 'recent' });

  assert.equal(hasSms(byPointOfSale, sms.id), false, 'le point de vente et la note ne doivent pas alimenter q');
  assert.equal(hasSms(byAmount, sms.id), false, 'le montant doit rester dans son filtre dedie');
  assert.equal(hasSms(byOrdinaryContent, contentOnlySms.id), false, 'le contenu ordinaire ne doit pas devenir une recherche plein texte');
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
