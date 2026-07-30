import { createHash, randomUUID } from 'node:crypto';
import { pool } from '../db.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export async function findActivePartnerKey(partnerId, keyId) {
  const { rows } = await pool.query(
    `SELECT k.*, p.is_active AS partner_active
     FROM automatic_sms_partner_key k
     JOIN automatic_sms_partner p ON p.id=k.partner_id
     WHERE k.id=$1 AND k.partner_id=$2`,
    [keyId, partnerId],
  );
  return rows[0] ?? null;
}

export async function consumeNonce(keyId, nonce) {
  const { rowCount } = await pool.query(
    `INSERT INTO automatic_sms_nonce(key_id, nonce) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`,
    [keyId, nonce],
  );
  await pool.query(`DELETE FROM automatic_sms_nonce WHERE created_at < now() - interval '24 hours'`);
  return rowCount === 1;
}

export async function recipientOptedOut(normalizedPhone) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM automatic_sms_opt_out WHERE normalized_phone=$1`,
    [normalizedPhone],
  );
  return rowCount > 0;
}

export async function auditIngress(data) {
  await pool.query(
    `INSERT INTO automatic_sms_ingress_audit(
       partner_id,key_id,request_id,campaign_id,phone_hash,outcome,http_status
     ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      data.partnerId || null,
      data.keyId || null,
      data.requestId || null,
      data.campaignId || null,
      data.normalizedPhone ? sha256(data.normalizedPhone) : null,
      data.outcome,
      data.httpStatus,
    ],
  );
}

export async function createDispatchRequest(data) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT * FROM automatic_sms_request WHERE partner_id=$1 AND request_id=$2 FOR UPDATE`,
      [data.partnerId, data.requestId],
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return { item: existing.rows[0], existing: true, duplicateRecipient: false };
    }
    const id = randomUUID();
    try {
      const { rows } = await client.query(
        `INSERT INTO automatic_sms_request(
           id, partner_id, partner_key_id, request_id, campaign_id,
           rendered_text, normalized_phone, scheduled_at, expires_at, raw_body, signature,
           signature_timestamp, signature_nonce, status,
           consent_reference, consent_captured_at, consent_source, consent_version
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
           'PENDING',$14,$15,$16,$17
         ) RETURNING *`,
        [
          id, data.partnerId, data.keyId, data.requestId, data.campaignId,
          data.message, data.normalizedPhone, data.scheduledAt, data.expiresAt,
          data.rawBody, data.signature, data.timestamp, data.nonce,
          data.consent.reference, data.consent.capturedAt,
          data.consent.source, data.consent.version,
        ],
      );
      await client.query('COMMIT');
      return { item: rows[0], existing: false, duplicateRecipient: false };
    } catch (error) {
      if (error.code !== '23505') throw error;
      const duplicate = await client.query(
        `SELECT * FROM automatic_sms_request
         WHERE partner_id=$1 AND campaign_id=$2 AND normalized_phone=$3`,
        [data.partnerId, data.campaignId, data.normalizedPhone],
      );
      await client.query('COMMIT');
      return { item: duplicate.rows[0], existing: true, duplicateRecipient: true };
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function claimNext() {
  const { rows } = await pool.query(
    `SELECT r.*, k.public_key_pem
     FROM automatic_sms_request r
     JOIN automatic_sms_partner_key k ON k.id=r.partner_key_id
     JOIN automatic_sms_partner p ON p.id=r.partner_id
     WHERE r.delivered_to_device_at IS NULL
       AND r.status IN ('PENDING','WAITING_ADVANCED_MODE','FAILED_RETRYABLE')
       AND r.scheduled_at <= now()
       AND r.expires_at > now()
       AND p.is_active=true AND k.is_active=true
     ORDER BY r.created_at ASC LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function markReceived(requestId) {
  const { rows } = await pool.query(
    `UPDATE automatic_sms_request
     SET delivered_to_device_at=COALESCE(delivered_to_device_at, now()), updated_at=now()
     WHERE id=$1 RETURNING *`,
    [requestId],
  );
  return rows[0] ?? null;
}

export async function authorizeSend(requestId) {
  const { rows } = await pool.query(
    `UPDATE automatic_sms_request r SET authorization_until=now()+interval '15 minutes', updated_at=now()
     FROM automatic_sms_partner p, automatic_sms_partner_key k
     WHERE r.id=$1
       AND p.id=r.partner_id AND p.is_active=true
       AND k.id=r.partner_key_id AND k.is_active=true
       AND r.expires_at>now()
       AND r.status NOT IN ('SENT','DELIVERED','FAILED_FINAL','BLOCKED')
     RETURNING r.authorization_until`,
    [requestId],
  );
  return rows[0] ?? null;
}

export async function appendEvents(events) {
  const client = await pool.connect();
  const acceptedEventIds = [];
  const rank = {
    WAITING_ADVANCED_MODE: 10,
    PENDING: 20,
    FAILED_RETRYABLE: 25,
    PROCESSING: 30,
    SENT: 40,
    DELIVERED: 50,
    FAILED_FINAL: 50,
    BLOCKED: 50,
    CANCELLED: 50,
  };
  try {
    await client.query('BEGIN');
    for (const event of events) {
      const inserted = await client.query(
        `INSERT INTO automatic_sms_event(
           event_id, request_id, status, reason, details, occurred_at
         ) SELECT $1,$2,$3,$4,$5,$6
         WHERE EXISTS(
           SELECT 1 FROM automatic_sms_request WHERE id=$2
         ) ON CONFLICT DO NOTHING`,
        [
          event.eventId, event.requestId, event.status,
          event.reason ?? null, event.details ?? {}, event.occurredAt,
        ],
      );
      if (inserted.rowCount) {
        acceptedEventIds.push(event.eventId);
        const current = await client.query(
          `SELECT r.status,p.is_active AS partner_active,k.is_active AS key_active
           FROM automatic_sms_request r
           JOIN automatic_sms_partner p ON p.id=r.partner_id
           JOIN automatic_sms_partner_key k ON k.id=r.partner_key_id
           WHERE r.id=$1`,
          [event.requestId],
        );
        const state = current.rows[0];
        if (state) {
          const forcedBlocked = !state.partner_active || !state.key_active;
          const canAdvance = (rank[event.status] ?? 0) >= (rank[state.status] ?? 0);
          if (forcedBlocked || canAdvance) {
            await client.query(
              `UPDATE automatic_sms_request SET status=$2,status_reason=$3,updated_at=now()
               WHERE id=$1`,
              [
                event.requestId,
                forcedBlocked ? 'BLOCKED' : event.status,
                !state.partner_active ? 'PARTNER_REVOKED'
                  : !state.key_active ? 'KEY_REVOKED'
                    : event.reason ?? null,
              ],
            );
          }
        }
      }
    }
    await client.query('COMMIT');
    return acceptedEventIds;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createPartner({ id, name }) {
  const { rows } = await pool.query(
    `INSERT INTO automatic_sms_partner(id,name)
     VALUES($1,$2)
     ON CONFLICT(id) DO UPDATE
       SET name=EXCLUDED.name,is_active=true,updated_at=now()
     RETURNING *`,
    [id, name],
  );
  return rows[0];
}

export async function deactivatePartner(partnerId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE automatic_sms_partner
       SET is_active=false,updated_at=now()
       WHERE id=$1 AND is_active=true
       RETURNING id,name`,
      [partnerId],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      `UPDATE automatic_sms_partner_key
       SET is_active=false,revoked_at=COALESCE(revoked_at,now())
       WHERE partner_id=$1 AND is_active=true`,
      [partnerId],
    );
    await client.query(
      `UPDATE automatic_sms_request
       SET status='BLOCKED',status_reason='PARTNER_REVOKED',updated_at=now()
       WHERE partner_id=$1
         AND status NOT IN ('SENT','DELIVERED','FAILED_FINAL','CANCELLED')`,
      [partnerId],
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function dashboardState() {
  const [partners, keys, requests] = await Promise.all([
    pool.query(`
      SELECT p.*,
        (SELECT count(*)::int FROM automatic_sms_partner_key k
         WHERE k.partner_id=p.id AND k.is_active=true) AS active_keys
      FROM automatic_sms_partner p
      ORDER BY p.name
    `),
    pool.query(`SELECT id,partner_id,label,is_active,created_at,revoked_at FROM automatic_sms_partner_key ORDER BY created_at DESC`),
    pool.query(`SELECT * FROM automatic_sms_request ORDER BY created_at DESC LIMIT 200`),
  ]);
  return {
    partners: partners.rows,
    keys: keys.rows,
    requests: requests.rows,
  };
}

export async function addOptOut(normalizedPhone, source, reason) {
  const { rows } = await pool.query(
    `INSERT INTO automatic_sms_opt_out(normalized_phone,source,reason)
     VALUES($1,$2,$3)
     ON CONFLICT(normalized_phone) DO UPDATE SET source=EXCLUDED.source,reason=EXCLUDED.reason
     RETURNING *`,
    [normalizedPhone, source, reason || null],
  );
  return rows[0];
}

export async function removeOptOut(normalizedPhone) {
  const { rowCount } = await pool.query(
    `DELETE FROM automatic_sms_opt_out WHERE normalized_phone=$1`,
    [normalizedPhone],
  );
  return rowCount > 0;
}

export async function setPartnerActive(partnerId, active) {
  const { rows } = await pool.query(
    `UPDATE automatic_sms_partner SET is_active=$2,updated_at=now()
     WHERE id=$1 RETURNING *`,
    [partnerId, active],
  );
  if (rows[0] && !active) {
    await pool.query(
      `UPDATE automatic_sms_request SET status='BLOCKED',status_reason='PARTNER_REVOKED',updated_at=now()
       WHERE partner_id=$1 AND status NOT IN ('SENT','DELIVERED','FAILED_FINAL')`,
      [partnerId],
    );
  }
  return rows[0] ?? null;
}

export async function insertPartnerKey({ partnerId, keyId, publicKeyPem, label }) {
  const { rows } = await pool.query(
    `INSERT INTO automatic_sms_partner_key(id,partner_id,public_key_pem,label)
     VALUES($1,$2,$3,$4) RETURNING id,partner_id,label,is_active,created_at`,
    [keyId, partnerId, publicKeyPem, label],
  );
  return rows[0];
}

export async function revokePartnerKey(keyId) {
  const { rows } = await pool.query(
    `UPDATE automatic_sms_partner_key SET is_active=false,revoked_at=now()
     WHERE id=$1 RETURNING id,partner_id,revoked_at`,
    [keyId],
  );
  if (rows[0]) {
    await pool.query(
      `UPDATE automatic_sms_request SET status='BLOCKED', status_reason='KEY_REVOKED', updated_at=now()
       WHERE partner_key_id=$1 AND status NOT IN ('SENT','DELIVERED','FAILED_FINAL')`,
      [keyId],
    );
  }
  return rows[0] ?? null;
}
