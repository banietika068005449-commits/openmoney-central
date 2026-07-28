import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCongoPhone } from './phone.js';

test('normalise les formats congolais acceptes', () => {
  assert.equal(normalizeCongoPhone('06 123 45 67'), '+242061234567');
  assert.equal(normalizeCongoPhone('05-123-45-67'), '+242051234567');
  assert.equal(normalizeCongoPhone('00242 04 123 45 67'), '+242041234567');
  assert.equal(normalizeCongoPhone('242061234567'), '+242061234567');
});

test('refuse les longueurs, pays et prefixes invalides', () => {
  assert.equal(normalizeCongoPhone('+242071234567'), null);
  assert.equal(normalizeCongoPhone('+33612345678'), null);
  assert.equal(normalizeCongoPhone('06123456'), null);
  assert.equal(normalizeCongoPhone('06ABC4567'), null);
});
