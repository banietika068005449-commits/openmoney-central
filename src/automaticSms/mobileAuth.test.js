import { afterEach, test } from 'node:test';
import { strict as assert } from 'node:assert';

import { requireAutomaticSmsToken } from './mobileAuth.js';

const previousToken = process.env.AUTOMATIC_SMS_DISPATCHER_TOKEN;

afterEach(() => {
  if (previousToken === undefined) delete process.env.AUTOMATIC_SMS_DISPATCHER_TOKEN;
  else process.env.AUTOMATIC_SMS_DISPATCHER_TOKEN = previousToken;
});

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test('renvoie 503 lorsque le jeton SMS serveur est absent', () => {
  delete process.env.AUTOMATIC_SMS_DISPATCHER_TOKEN;
  const res = response();

  requireAutomaticSmsToken({ headers: {} }, res, () => assert.fail('next ne doit pas etre appele'));

  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.error, 'AUTOMATIC_SMS_DISPATCHER_TOKEN_NOT_CONFIGURED');
});

test('refuse un jeton SMS invalide', () => {
  process.env.AUTOMATIC_SMS_DISPATCHER_TOKEN = 'configured-token';
  const res = response();

  requireAutomaticSmsToken(
    { headers: { authorization: 'Bearer invalid-token' } },
    res,
    () => assert.fail('next ne doit pas etre appele'),
  );

  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.error, 'DISPATCHER_TOKEN_INVALID');
});

test('accepte le jeton SMS dedie', () => {
  process.env.AUTOMATIC_SMS_DISPATCHER_TOKEN = 'configured-token';
  const res = response();
  let called = false;

  requireAutomaticSmsToken(
    { headers: { authorization: 'Bearer configured-token' } },
    res,
    () => { called = true; },
  );

  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
});
