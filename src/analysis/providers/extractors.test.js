import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { BaseSmsAnalyzer } from './base.js';
import { MtnSmsAnalyzer } from './mtn.js';
import { AirtelSmsAnalyzer } from './airtel.js';
import { UnknownSmsAnalyzer } from './unknown.js';

const base = new BaseSmsAnalyzer();

// ---------- parseAmount ----------

test('parseAmount: entier simple', () => {
  assert.equal(base.parseAmount('10000'), 10000);
});

test('parseAmount: format FR avec espaces', () => {
  assert.equal(base.parseAmount('10 000'), 10000);
  assert.equal(base.parseAmount('1 234 567'), 1234567);
});

test('parseAmount: format FR avec virgule decimale', () => {
  assert.equal(base.parseAmount('1 234,56'), 1234.56);
  assert.equal(base.parseAmount('10 000,50'), 10000.50);
});

test('parseAmount: format FR avec point comme separateur de milliers', () => {
  assert.equal(base.parseAmount('10.000'), 10000);
  assert.equal(base.parseAmount('2.500,50'), 2500.50);
});

test('parseAmount: format EN', () => {
  assert.equal(base.parseAmount('1,234.56'), 1234.56);
  assert.equal(base.parseAmount('10,000'), 10000);
});

test('parseAmount: vide/invalide -> null', () => {
  assert.equal(base.parseAmount(''), null);
  assert.equal(base.parseAmount('abc'), null);
  assert.equal(base.parseAmount(null), null);
});

// ---------- extractMainAmount / extractBalance ----------

test('extractMainAmount: keyword AVANT le montant', () => {
  assert.equal(base.extractMainAmount('Vous avez recu 10 000 FCFA'), 10000);
  assert.equal(base.extractMainAmount('Paiement de 2 500 FCFA effectue'), 2500);
});

test('extractMainAmount: keyword APRES le montant', () => {
  assert.equal(base.extractMainAmount('2 500 FCFA reçus avec succes'), 2500);
});

test('extractMainAmount: rien de transactionnel -> null', () => {
  assert.equal(base.extractMainAmount('Solde actuel: 75 000 FCFA'), null);
});

test('extractBalance: solde simple', () => {
  assert.equal(base.extractBalance('Solde: 25 000 FCFA'), 25000);
  assert.equal(base.extractBalance('Nouveau solde: 18 500 FCFA'), 18500);
  assert.equal(base.extractBalance('Solde actuel: 75 000 FCFA'), 75000);
});

test('extractBalance: pas de solde -> null', () => {
  assert.equal(base.extractBalance('Vous avez recu 10 000 FCFA'), null);
});

test('amount et balance distincts dans le meme SMS', () => {
  const sms = 'Vous avez recu 10 000 FCFA. Solde: 25 000 FCFA';
  assert.equal(base.extractMainAmount(sms), 10000);
  assert.equal(base.extractBalance(sms), 25000);
});

// ---------- extractPhoneNumber ----------

test('extractPhoneNumber: format international +xxx', () => {
  const sms = 'Vous avez recu 10 000 FCFA de +242066123456';
  assert.equal(base.extractPhoneNumber(sms), '+242066123456');
});

test('extractPhoneNumber: aucun numero -> null', () => {
  assert.equal(base.extractPhoneNumber('Solde actuel: 75 000 FCFA'), null);
});

// ---------- extractReference / extractTransactionId ----------

test('extractReference: Ref: ABC123', () => {
  assert.equal(base.extractReference('Solde: 25 000 FCFA. Ref: ABC123'), 'ABC123');
});

test('extractReference: Ref TX9988 (sans deux-points)', () => {
  assert.equal(base.extractReference('Paiement effectue. Ref TX9988'), 'TX9988');
});

test('extractReference: aucune ref -> null', () => {
  assert.equal(base.extractReference('Vous avez recu 10 000 FCFA'), null);
});

test('extractTransactionId: TX:XYZ123', () => {
  assert.equal(base.extractTransactionId('Operation TX:XYZ123'), 'XYZ123');
});

// ---------- detectSmsType ----------

test('detectSmsType: money_received', () => {
  assert.equal(base.detectSmsType('Vous avez recu 10 000 FCFA'), 'money_received');
  assert.equal(base.detectSmsType('Votre compte a ete credite'), 'money_received');
});

test('detectSmsType: money_sent', () => {
  assert.equal(base.detectSmsType('Vous avez envoye 5 000 FCFA'), 'money_sent');
  assert.equal(base.detectSmsType('Votre compte a ete debite'), 'money_sent');
});

test('detectSmsType: payment', () => {
  assert.equal(base.detectSmsType('Paiement de 2 500 FCFA effectue'), 'payment');
});

test('detectSmsType: cash_out', () => {
  assert.equal(base.detectSmsType('Retrait de 5 000 FCFA effectue'), 'cash_out');
});

test('detectSmsType: balance_check (seul mot de solde)', () => {
  assert.equal(base.detectSmsType('Solde actuel: 75 000 FCFA'), 'balance_check');
});

test('detectSmsType: unknown', () => {
  assert.equal(base.detectSmsType('Bonjour votre forfait internet expire demain.'), 'unknown');
});

// ---------- detectCurrency ----------

test('detectCurrency: FCFA explicite', () => {
  assert.equal(base.detectCurrency('Solde: 10 000 FCFA'), 'FCFA');
});

test('detectCurrency: XAF', () => {
  assert.equal(base.detectCurrency('Solde: 10 000 XAF'), 'XAF');
});

test('detectCurrency: aucune -> defaut FCFA', () => {
  assert.equal(base.detectCurrency('Bonjour'), 'FCFA');
});

// ---------- Cas du spec : pipeline complet via UnknownSmsAnalyzer ----------

const unknown = new UnknownSmsAnalyzer();
const mtn = new MtnSmsAnalyzer();
const airtel = new AirtelSmsAnalyzer();

test('Cas 1 (spec) : recu + solde + ref + phone', async () => {
  const sms = 'Vous avez reçu 10 000 FCFA de +242066123456. Solde: 25 000 FCFA. Ref: ABC123';
  const r = await unknown.analyze('MTN', sms);
  assert.equal(r.smsType, 'money_received');
  assert.equal(r.amount, 10000);
  assert.equal(r.balance, 25000);
  assert.equal(r.phoneNumber, '+242066123456');
  assert.equal(r.reference, 'ABC123');
});

test('Cas 2 (spec) : envoye + nouveau solde', async () => {
  const sms = 'Vous avez envoyé 5 000 FCFA à +242055123456. Nouveau solde: 18 500 FCFA';
  const r = await unknown.analyze('Airtel', sms);
  assert.equal(r.smsType, 'money_sent');
  assert.equal(r.amount, 5000);
  assert.equal(r.balance, 18500);
});

test('Cas 3 (spec) : solde seul -> balance_check, amount null', async () => {
  const r = await unknown.analyze('OP', 'Solde actuel: 75 000 FCFA');
  assert.equal(r.smsType, 'balance_check');
  assert.equal(r.amount, null);
  assert.equal(r.balance, 75000);
});

test('Cas 4 (spec) : paiement avec reference', async () => {
  const r = await unknown.analyze('OP', 'Paiement de 2 500 FCFA effectué avec succès. Ref TX9988');
  assert.equal(r.smsType, 'payment');
  assert.equal(r.amount, 2500);
  assert.equal(r.reference, 'TX9988');
});

test('Cas 5 (spec) : SMS non utile -> ignored', async () => {
  const r = await unknown.analyze('Operator', 'Bonjour votre forfait internet expire demain.');
  assert.equal(r.smsType, 'unknown');
  assert.equal(r.amount, null);
  assert.equal(r.balance, null);
  assert.equal(r.analysisStatus, 'ignored');
});

// ---------- canAnalyze ----------

test('MtnSmsAnalyzer.canAnalyze : MTN sender', () => {
  assert.ok(mtn.canAnalyze('MTN', 'Vous avez recu 10 000 FCFA'));
  assert.ok(mtn.canAnalyze('+242', 'MTN MoMo: Vous avez recu'));
  assert.equal(mtn.canAnalyze('+242', 'Airtel Money: solde'), false);
});

test('AirtelSmsAnalyzer.canAnalyze : Airtel sender', () => {
  assert.ok(airtel.canAnalyze('Airtel', 'Solde 25 000 FCFA'));
  assert.ok(airtel.canAnalyze('+242', 'Airtel Money: vous avez recu'));
  assert.equal(airtel.canAnalyze('MTN', 'MoMo: vous avez recu'), false);
});

test('UnknownSmsAnalyzer.canAnalyze : toujours true', () => {
  assert.ok(unknown.canAnalyze('?', 'n importe quoi'));
});

// ---------- Provider integration via MTN ----------

test('MtnSmsAnalyzer.analyze : enrichi correctement le result', async () => {
  const sms = 'Vous avez reçu 10 000 FCFA de +242066123456. Solde: 25 000 FCFA. Ref: ABC123';
  const r = await mtn.analyze('MTN', sms);
  assert.equal(r.provider, 'mtn-sms-analyzer');
  assert.equal(r.operator, 'MTN');
  assert.equal(r.smsType, 'money_received');
  assert.equal(r.amount, 10000);
  assert.equal(r.balance, 25000);
  assert.equal(r.phoneNumber, '+242066123456');
  assert.equal(r.reference, 'ABC123');
  assert.equal(r.currency, 'FCFA');
  assert.equal(r.analysisStatus, 'success');
  assert.ok(r.confidence > 0.5, `confidence trop basse: ${r.confidence}`);
});

// ---------- Edge cases ----------

test('Edge: accents manquants (recu/credite/envoye)', async () => {
  const r = await unknown.analyze('OP', 'Vous avez recu 10 000 FCFA. Solde: 25 000 FCFA');
  assert.equal(r.smsType, 'money_received');
  assert.equal(r.amount, 10000);
  assert.equal(r.balance, 25000);
});

test('Edge: format FR avec point puis virgule (2.500,50)', () => {
  assert.equal(base.extractMainAmount('Paiement de 2.500,50 FCFA'), 2500.50);
});

test('Edge: format EN (1,234.56)', () => {
  assert.equal(base.extractMainAmount('Paiement de 1,234.56 FCFA'), 1234.56);
});

test('Edge: ordre inverse (montant puis verbe)', () => {
  // "2 500 FCFA recus" -> apres-le-nombre
  assert.equal(base.extractMainAmount('2 500 FCFA recu de John'), 2500);
});

test('Edge: confidence cas 5 reste basse', async () => {
  const r = await unknown.analyze('OP', 'Bonjour votre forfait internet expire demain.');
  assert.equal(r.confidence, 0);
});
