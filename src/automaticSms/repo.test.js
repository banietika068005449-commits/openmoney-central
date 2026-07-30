import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import { strict as assert } from 'node:assert';

import { pool } from '../db.js';
import { ensureAutomaticSmsSchema } from './schema.js';
import {
  appendEvents,
  authorizeSend,
  claimNext,
  createDispatchRequest,
  markReceived,
} from './repo.js';

const PARTNER_ID = 'test_global_dispatcher';

async function cleanup() {
  await pool.query(`DELETE FROM automatic_sms_request WHERE partner_id=$1`, [PARTNER_ID]);
  await pool.query(`DELETE FROM automatic_sms_partner WHERE id=$1`, [PARTNER_ID]);
}

async function seed() {
  const keyId = randomUUID();
  await pool.query(
    `INSERT INTO automatic_sms_partner(id,name) VALUES($1,'Test file globale')`,
    [PARTNER_ID],
  );
  await pool.query(
    `INSERT INTO automatic_sms_partner_key(id,partner_id,public_key_pem,label)
     VALUES($1,$2,'test-public-key','test')`,
    [keyId, PARTNER_ID],
  );
  const id = randomUUID();
  await pool.query(
    `INSERT INTO automatic_sms_request(
       id,partner_id,partner_key_id,request_id,campaign_id,rendered_text,normalized_phone,
       scheduled_at,expires_at,raw_body,signature,signature_timestamp,
       signature_nonce,status
     ) VALUES(
       $1,$2,$3,$4,'test-campaign','Test','+242060000000',
       now(),now()+interval '1 hour','{}','signature',
       now()::text,'test-nonce','PENDING'
     )`,
    [id, PARTNER_ID, keyId, randomUUID()],
  );
  return { id };
}

async function seedIdentity() {
  const keyId = randomUUID();
  await pool.query(
    `INSERT INTO automatic_sms_partner(id,name) VALUES($1,'Test file globale')`,
    [PARTNER_ID],
  );
  await pool.query(
    `INSERT INTO automatic_sms_partner_key(id,partner_id,public_key_pem,label)
     VALUES($1,$2,'test-public-key','test')`,
    [keyId, PARTNER_ID],
  );
  return keyId;
}

beforeEach(async () => {
  await ensureAutomaticSmsSchema();
  await cleanup();
});

after(async () => {
  await cleanup();
  await pool.end();
});

test('reclame une demande globale sans terminal ni affectation', async () => {
  const seeded = await seed();

  const claim = await claimNext();

  assert.equal(claim.id, seeded.id);
  assert.equal(claim.partner_id, PARTNER_ID);
  assert.equal(claim.dispatcher_id, null);
});

test('cree directement une demande PENDING sans affectation', async () => {
  const keyId = await seedIdentity();
  const result = await createDispatchRequest({
    partnerId: PARTNER_ID,
    keyId,
    requestId: randomUUID(),
    campaignId: 'test-campaign-create',
    message: 'Test',
    normalizedPhone: '+242060000001',
    scheduledAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60_000),
    rawBody: '{}',
    signature: 'signature',
    timestamp: new Date().toISOString(),
    nonce: 'test-nonce-create',
    consent: {
      reference: 'test-consent',
      capturedAt: new Date().toISOString(),
      source: 'partner_manual',
      version: 'test-v1',
    },
  });

  assert.equal(result.existing, false);
  assert.equal(result.item.status, 'PENDING');
  assert.equal(result.item.status_reason, null);
  assert.equal(result.item.dispatcher_id, null);
});

test('accuse, autorise et synchronise un evenement sans dispatcher', async () => {
  const seeded = await seed();

  const received = await markReceived(seeded.id);
  assert.equal(received.id, seeded.id);
  assert.ok(received.delivered_to_device_at);

  const authorization = await authorizeSend(seeded.id);
  assert.ok(authorization.authorization_until);

  const eventId = randomUUID();
  const accepted = await appendEvents([{
    eventId,
    requestId: seeded.id,
    status: 'SENT',
    occurredAt: new Date().toISOString(),
  }]);
  assert.deepEqual(accepted, [eventId]);

  const { rows } = await pool.query(
    `SELECT r.status,e.dispatcher_id
       FROM automatic_sms_request r
       JOIN automatic_sms_event e ON e.request_id=r.id
      WHERE r.id=$1`,
    [seeded.id],
  );
  assert.deepEqual(rows[0], { status: 'SENT', dispatcher_id: null });
});
