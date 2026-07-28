import { createHash, createPublicKey, verify } from 'node:crypto';

export function signaturePayload({
  method = 'POST',
  path = '/api/partner/v1/automatic-sms/requests',
  partnerId,
  keyId,
  timestamp,
  nonce,
  rawBody,
}) {
  const digest = createHash('sha256').update(rawBody).digest('base64url');
  return Buffer.from([
    'OPENMONEY-SMS-V1',
    method.toUpperCase(),
    path,
    partnerId,
    keyId,
    timestamp,
    nonce,
    digest,
  ].join('\n'), 'utf8');
}

export function verifyPartnerSignature(args) {
  try {
    const publicKey = createPublicKey(args.publicKeyPem);
    return verify(
      null,
      signaturePayload(args),
      publicKey,
      Buffer.from(args.signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
