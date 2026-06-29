import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePushSubscriptionPayload, validatePushSendPayload } from './pushNotification.service.js';

test('validatePushSubscriptionPayload rejects missing fields', () => {
  assert.throws(() => validatePushSubscriptionPayload({ endpoint: 'https://example.com' }), /endpoint/);
});

test('validatePushSendPayload accepts a valid notification payload', () => {
  const payload = validatePushSendPayload({
    title: 'Nouvelle transaction',
    body: 'Une transaction a été reçue',
    url: '/?tab=sms',
  });

  assert.equal(payload.title, 'Nouvelle transaction');
  assert.equal(payload.body, 'Une transaction a été reçue');
  assert.equal(payload.url, '/?tab=sms');
});
