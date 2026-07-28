import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { signaturePayload, verifyPartnerSignature } from './signature.js';

test('verifie une enveloppe Ed25519 et refuse un corps modifie', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const args = {
    partnerId: 'tecno_ya_niongo',
    keyId: 'key-1',
    timestamp: '1785225600',
    nonce: 'nonce-unique',
    rawBody: Buffer.from('{"requestId":"req-1"}'),
  };
  const signature = sign(null, signaturePayload(args), privateKey).toString('base64url');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(verifyPartnerSignature({ ...args, signature, publicKeyPem }), true);
  assert.equal(verifyPartnerSignature({
    ...args,
    rawBody: Buffer.from('{"requestId":"req-2"}'),
    signature,
    publicKeyPem,
  }), false);
});
