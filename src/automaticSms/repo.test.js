import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import { strict as assert } from 'node:assert';

import { pool } from '../db.js';
import { ensureAutomaticSmsSchema } from './schema.js';
import { reactivateAndAssignDispatcher } from './repo.js';

const PARTNER_ID = 'test_reactivate_dispatcher';
const DISPATCHER_ID = '11111111-1111-4111-8111-111111111111';
const UNENROLLED_ID = '22222222-2222-4222-8222-222222222222';

async function cleanup() {
  await pool.query(`DELETE FROM automatic_sms_request WHERE partner_id=$1`, [PARTNER_ID]);
  await pool.query(`DELETE FROM automatic_sms_partner WHERE id=$1`, [PARTNER_ID]);
  await pool.query(
    `DELETE FROM automatic_sms_dispatcher WHERE id IN ($1,$2)`,
    [DISPATCHER_ID, UNENROLLED_ID],
  );
}

async function seed({ enrolled = true } = {}) {
  await pool.query(
    `INSERT INTO automatic_sms_partner(id,name) VALUES($1,'Test reactivation')`,
    [PARTNER_ID],
  );
  const keyId = randomUUID();
  await pool.query(
    `INSERT INTO automatic_sms_partner_key(id,partner_id,public_key_pem,label)
     VALUES($1,$2,'test-public-key','test')`,
    [keyId, PARTNER_ID],
  );
  await pool.query(
    `INSERT INTO automatic_sms_dispatcher(id,name,device_id,token_hash,is_active)
     VALUES($1,'Test v1',$2,$3,false)`,
    [
      enrolled ? DISPATCHER_ID : UNENROLLED_ID,
      enrolled ? 'test-device-reactivation' : null,
      enrolled ? 'a'.repeat(64) : null,
    ],
  );
  if (enrolled) {
    await pool.query(
      `INSERT INTO automatic_sms_request(
         id,partner_id,partner_key_id,request_id,campaign_id,template_id,
         template_version,template_body,variables,rendered_text,normalized_phone,
         scheduled_at,expires_at,raw_body,signature,signature_timestamp,
         signature_nonce,status,status_reason
       ) VALUES(
         $1,$2,$3,$4,'test-campaign','test-template',1,'Test','{}'::jsonb,
         'Test','+242060000000',now(),now()+interval '1 hour','{}','signature',
         now()::text,'test-nonce','WAITING_DISPATCHER','DISPATCHER_NOT_ASSIGNED'
       )`,
      [randomUUID(), PARTNER_ID, keyId, randomUUID()],
    );
  }
}

beforeEach(async () => {
  await ensureAutomaticSmsSchema();
  await cleanup();
});

after(async () => {
  await cleanup();
  await pool.end();
});

test('reactive, affecte et remet en file les demandes sans dispatcher', async () => {
  await seed();

  const result = await reactivateAndAssignDispatcher(DISPATCHER_ID, PARTNER_ID);
  assert.equal(result.dispatcher.is_active, true);
  assert.equal(result.assignment.partner_id, PARTNER_ID);
  assert.equal(result.assignment.dispatcher_id, DISPATCHER_ID);
  assert.equal(result.requeuedCount, 1);

  const { rows } = await pool.query(
    `SELECT dispatcher_id,status,status_reason
     FROM automatic_sms_request WHERE partner_id=$1`,
    [PARTNER_ID],
  );
  assert.deepEqual(rows[0], {
    dispatcher_id: DISPATCHER_ID,
    status: 'PENDING',
    status_reason: null,
  });

  const replay = await reactivateAndAssignDispatcher(DISPATCHER_ID, PARTNER_ID);
  assert.equal(replay.requeuedCount, 0);
});

test('refuse de reactiver un terminal non enrole', async () => {
  await seed({ enrolled: false });

  await assert.rejects(
    reactivateAndAssignDispatcher(UNENROLLED_ID, PARTNER_ID),
    (error) => error.message === 'DISPATCHER_NOT_ENROLLED' && error.status === 409,
  );
});

test('refuse un partenaire inconnu', async () => {
  await seed();

  await assert.rejects(
    reactivateAndAssignDispatcher(DISPATCHER_ID, 'test_partner_unknown'),
    (error) => error.message === 'PARTNER_NOT_FOUND' && error.status === 404,
  );
});
