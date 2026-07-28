import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

export async function activeTemplate(templateId) {
  const { rows } = await pool.query(
    `SELECT * FROM automatic_sms_template
     WHERE id=$1 AND is_active=true ORDER BY version DESC LIMIT 1`,
    [templateId],
  );
  return rows[0] ?? null;
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
    const assignment = await client.query(
      `SELECT dispatcher_id FROM automatic_sms_partner_dispatcher WHERE partner_id=$1`,
      [data.partnerId],
    );
    const dispatcherId = assignment.rows[0]?.dispatcher_id ?? null;
    const id = randomUUID();
    try {
      const { rows } = await client.query(
        `INSERT INTO automatic_sms_request(
           id, partner_id, partner_key_id, request_id, campaign_id, dispatcher_id,
           template_id, template_version, template_body, variables, rendered_text,
           normalized_phone, scheduled_at, expires_at, raw_body, signature,
           signature_timestamp, signature_nonce, status, status_reason
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
           CASE WHEN $6::text IS NULL THEN 'BLOCKED' ELSE 'PENDING' END,
           CASE WHEN $6::text IS NULL THEN 'DISPATCHER_NOT_ASSIGNED' ELSE NULL END
         ) RETURNING *`,
        [
          id, data.partnerId, data.keyId, data.requestId, data.campaignId, dispatcherId,
          data.templateId, data.templateVersion, data.templateBody, data.variables,
          data.renderedText, data.normalizedPhone, data.scheduledAt, data.expiresAt,
          data.rawBody, data.signature, data.timestamp, data.nonce,
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

export async function dispatcherFromToken(token) {
  const { rows } = await pool.query(
    `SELECT * FROM automatic_sms_dispatcher
     WHERE token_hash=$1 AND is_active=true`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function claimNext(dispatcherId) {
  const { rows } = await pool.query(
    `SELECT r.*, k.public_key_pem
     FROM automatic_sms_request r
     JOIN automatic_sms_partner_key k ON k.id=r.partner_key_id
     JOIN automatic_sms_partner p ON p.id=r.partner_id
     WHERE r.dispatcher_id=$1
       AND r.delivered_to_device_at IS NULL
       AND r.status IN ('PENDING','WAITING_ADVANCED_MODE','FAILED_RETRYABLE')
       AND r.expires_at > now()
       AND p.is_active=true AND k.is_active=true
     ORDER BY r.created_at ASC LIMIT 1`,
    [dispatcherId],
  );
  await pool.query(
    `UPDATE automatic_sms_dispatcher SET last_seen_at=now() WHERE id=$1`,
    [dispatcherId],
  );
  return rows[0] ?? null;
}

export async function markReceived(requestId, dispatcherId) {
  const { rows } = await pool.query(
    `UPDATE automatic_sms_request
     SET delivered_to_device_at=COALESCE(delivered_to_device_at, now()), updated_at=now()
     WHERE id=$1 AND dispatcher_id=$2 RETURNING *`,
    [requestId, dispatcherId],
  );
  return rows[0] ?? null;
}

export async function authorizeSend(requestId, dispatcherId) {
  const { rows } = await pool.query(
    `UPDATE automatic_sms_request r SET authorization_until=now()+interval '15 minutes', updated_at=now()
     FROM automatic_sms_partner p, automatic_sms_partner_key k
     WHERE r.id=$1 AND r.dispatcher_id=$2
       AND p.id=r.partner_id AND p.is_active=true
       AND k.id=r.partner_key_id AND k.is_active=true
       AND r.expires_at>now()
       AND r.status NOT IN ('SENT','DELIVERED','FAILED_FINAL','BLOCKED')
     RETURNING r.authorization_until`,
    [requestId, dispatcherId],
  );
  return rows[0] ?? null;
}

export async function appendEvents(dispatcherId, events) {
  const client = await pool.connect();
  let accepted = 0;
  try {
    await client.query('BEGIN');
    for (const event of events) {
      const inserted = await client.query(
        `INSERT INTO automatic_sms_event(
           event_id, request_id, dispatcher_id, status, reason, details, occurred_at
         ) SELECT $1,$2,$3,$4,$5,$6,$7
         WHERE EXISTS(
           SELECT 1 FROM automatic_sms_request WHERE id=$2 AND dispatcher_id=$3
         ) ON CONFLICT DO NOTHING`,
        [
          event.eventId, event.requestId, dispatcherId, event.status,
          event.reason ?? null, event.details ?? {}, event.occurredAt,
        ],
      );
      if (inserted.rowCount) {
        accepted += 1;
        await client.query(
          `UPDATE automatic_sms_request r SET
             status=CASE WHEN p.is_active AND k.is_active THEN $2 ELSE 'BLOCKED' END,
             status_reason=CASE
               WHEN NOT p.is_active THEN 'PARTNER_REVOKED'
               WHEN NOT k.is_active THEN 'KEY_REVOKED'
               ELSE $3
             END,
             updated_at=now()
           FROM automatic_sms_partner p, automatic_sms_partner_key k
           WHERE r.id=$1 AND r.dispatcher_id=$4
             AND p.id=r.partner_id AND k.id=r.partner_key_id`,
          [event.requestId, event.status, event.reason ?? null, dispatcherId],
        );
      }
    }
    await client.query('COMMIT');
    return accepted;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createDispatcher(name) {
  const id = randomUUID();
  const enrollmentCode = randomBytes(18).toString('base64url');
  const { rows } = await pool.query(
    `INSERT INTO automatic_sms_dispatcher(
       id, name, enrollment_code_hash, enrollment_expires_at
     ) VALUES($1,$2,$3,now()+interval '24 hours') RETURNING *`,
    [id, name, sha256(enrollmentCode)],
  );
  return { dispatcher: rows[0], enrollmentCode };
}

export async function deactivateDispatcher(dispatcherId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE automatic_sms_dispatcher
       SET is_active=false,updated_at=now()
       WHERE id=$1 AND is_active=true
       RETURNING id,name`,
      [dispatcherId],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(`DELETE FROM automatic_sms_partner_dispatcher WHERE dispatcher_id=$1`, [dispatcherId]);
    await client.query(
      `UPDATE automatic_sms_request
       SET status='BLOCKED',status_reason='DISPATCHER_REVOKED',updated_at=now()
       WHERE dispatcher_id=$1
         AND status NOT IN ('SENT','DELIVERED','FAILED_FINAL','CANCELLED')`,
      [dispatcherId],
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
    await client.query(`DELETE FROM automatic_sms_partner_dispatcher WHERE partner_id=$1`, [partnerId]);
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

export async function enrollDispatcher(code, deviceId) {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await pool.query(
    `UPDATE automatic_sms_dispatcher
     SET device_id=$2, token_hash=$3, enrollment_code_hash=NULL,
         enrollment_expires_at=NULL, last_seen_at=now(), updated_at=now()
     WHERE enrollment_code_hash=$1 AND enrollment_expires_at>now() AND is_active=true
     RETURNING id, name`,
    [sha256(code), deviceId, sha256(token)],
  );
  return rows[0] ? { ...rows[0], token } : null;
}

export async function assignDispatcher(partnerId, dispatcherId) {
  const { rows } = await pool.query(
    `INSERT INTO automatic_sms_partner_dispatcher(partner_id, dispatcher_id)
     VALUES($1,$2) ON CONFLICT(partner_id) DO UPDATE
       SET dispatcher_id=EXCLUDED.dispatcher_id, updated_at=now()
     RETURNING *`,
    [partnerId, dispatcherId],
  );
  await pool.query(
    `UPDATE automatic_sms_request SET dispatcher_id=$2, status='PENDING',
       status_reason=NULL, updated_at=now()
     WHERE partner_id=$1 AND dispatcher_id IS NULL AND status='BLOCKED'
       AND status_reason='DISPATCHER_NOT_ASSIGNED'`,
    [partnerId, dispatcherId],
  );
  return rows[0];
}

export async function dashboardState() {
  const [partners, keys, dispatchers, templates, requests] = await Promise.all([
    pool.query(`
      SELECT p.*, d.id AS dispatcher_id, d.name AS dispatcher_name,
        (SELECT count(*)::int FROM automatic_sms_partner_key k
         WHERE k.partner_id=p.id AND k.is_active=true) AS active_keys
      FROM automatic_sms_partner p
      LEFT JOIN automatic_sms_partner_dispatcher a ON a.partner_id=p.id
      LEFT JOIN automatic_sms_dispatcher d ON d.id=a.dispatcher_id
      ORDER BY p.name
    `),
    pool.query(`SELECT id,partner_id,label,is_active,created_at,revoked_at FROM automatic_sms_partner_key ORDER BY created_at DESC`),
    pool.query(`SELECT id,name,device_id,is_active,last_seen_at,created_at FROM automatic_sms_dispatcher ORDER BY created_at DESC`),
    pool.query(`SELECT * FROM automatic_sms_template ORDER BY id,version DESC`),
    pool.query(`SELECT * FROM automatic_sms_request ORDER BY created_at DESC LIMIT 200`),
  ]);
  return {
    partners: partners.rows,
    keys: keys.rows,
    dispatchers: dispatchers.rows,
    templates: templates.rows,
    requests: requests.rows,
  };
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

export async function createTemplate({ id, body, variableSchema }) {
  const { rows } = await pool.query(
    `INSERT INTO automatic_sms_template(id,version,body,variable_schema)
     VALUES($1,COALESCE((SELECT max(version)+1 FROM automatic_sms_template WHERE id=$1),1),$2,$3)
     RETURNING *`,
    [id, body, variableSchema],
  );
  return rows[0];
}

export async function deactivateTemplate(templateId) {
  const { rows } = await pool.query(
    `UPDATE automatic_sms_template
     SET is_active=false
     WHERE id=$1 AND is_active=true
     RETURNING id,version,is_active`,
    [templateId],
  );
  return rows;
}
