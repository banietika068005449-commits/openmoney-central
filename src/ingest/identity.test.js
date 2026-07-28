import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeMessages, normalizeTimestamp } from './identity.js';

const base = {
  numeroTel: ' MTN ',
  message: 'Depot   5 000 FCFA',
  smsRecuLe: '2026-07-28T10:00:00.000Z',
};

test('dedoublonne la meme identite SMS normalisee', () => {
  const messages = [
    base,
    {
      numeroTel: 'mtn',
      message: 'Depot 5 000 FCFA',
      smsRecuLe: '2026-07-28T12:00:00.000+02:00',
    },
  ];
  assert.equal(dedupeMessages(messages).length, 1);
});

test('conserve le meme contenu recu a deux instants differents', () => {
  const messages = [
    base,
    { ...base, smsRecuLe: '2026-07-28T10:01:00.000Z' },
  ];
  assert.equal(dedupeMessages(messages).length, 2);
});

test('normalise un timestamp ISO vers UTC avec millisecondes', () => {
  assert.equal(
    normalizeTimestamp('2026-07-28T12:00:00+02:00'),
    '2026-07-28T10:00:00.000Z',
  );
});
