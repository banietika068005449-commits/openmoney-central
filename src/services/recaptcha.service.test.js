import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { RecaptchaError, verifyRecaptchaToken } from './recaptcha.service.js';

function fetchJson(payload, ok = true, status = 200) {
  return async () => ({
    ok,
    status,
    json: async () => payload,
  });
}

test('verifyRecaptchaToken: refuse un token absent', async () => {
  await assert.rejects(
    () => verifyRecaptchaToken({ token: '', secretKey: 'secret', fetchImpl: fetchJson({ success: true }) }),
    (e) => e instanceof RecaptchaError && e.code === 'CAPTCHA_REQUIRED',
  );
});

test('verifyRecaptchaToken: accepte success=true', async () => {
  const ok = await verifyRecaptchaToken({
    token: 'captcha',
    secretKey: 'secret',
    fetchImpl: fetchJson({ success: true }),
  });
  assert.equal(ok, true);
});

test('verifyRecaptchaToken: mappe timeout-or-duplicate vers CAPTCHA_EXPIRED', async () => {
  await assert.rejects(
    () => verifyRecaptchaToken({
      token: 'captcha',
      secretKey: 'secret',
      fetchImpl: fetchJson({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    }),
    (e) => e instanceof RecaptchaError && e.code === 'CAPTCHA_EXPIRED',
  );
});

test('verifyRecaptchaToken: echec reseau -> CAPTCHA_VERIFICATION_FAILED', async () => {
  await assert.rejects(
    () => verifyRecaptchaToken({
      token: 'captcha',
      secretKey: 'secret',
      fetchImpl: async () => { throw new Error('network'); },
    }),
    (e) => e instanceof RecaptchaError && e.code === 'CAPTCHA_VERIFICATION_FAILED',
  );
});
