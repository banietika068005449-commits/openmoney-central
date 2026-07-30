import { pool } from '../db.js';

let ready = false;

export async function ensureAutomaticSmsSchema() {
  if (ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS automatic_sms_partner (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS automatic_sms_partner_key (
      id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL REFERENCES automatic_sms_partner(id) ON DELETE CASCADE,
      public_key_pem TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_automatic_sms_key_partner
      ON automatic_sms_partner_key(partner_id, is_active);

    CREATE TABLE IF NOT EXISTS automatic_sms_dispatcher (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      device_id TEXT UNIQUE,
      token_hash CHAR(64) UNIQUE,
      enrollment_code_hash CHAR(64) UNIQUE,
      enrollment_expires_at TIMESTAMPTZ,
      is_active BOOLEAN NOT NULL DEFAULT true,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS automatic_sms_partner_dispatcher (
      partner_id TEXT PRIMARY KEY REFERENCES automatic_sms_partner(id) ON DELETE CASCADE,
      dispatcher_id TEXT NOT NULL REFERENCES automatic_sms_dispatcher(id) ON DELETE RESTRICT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS automatic_sms_template (
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      variable_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(id, version)
    );
    CREATE TABLE IF NOT EXISTS automatic_sms_partner_template (
      partner_id TEXT NOT NULL REFERENCES automatic_sms_partner(id) ON DELETE CASCADE,
      template_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(partner_id, template_id)
    );

    CREATE TABLE IF NOT EXISTS automatic_sms_opt_out (
      normalized_phone TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS automatic_sms_nonce (
      key_id TEXT NOT NULL REFERENCES automatic_sms_partner_key(id) ON DELETE CASCADE,
      nonce TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(key_id, nonce)
    );

    CREATE TABLE IF NOT EXISTS automatic_sms_request (
      id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL REFERENCES automatic_sms_partner(id),
      partner_key_id TEXT NOT NULL REFERENCES automatic_sms_partner_key(id),
      request_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      dispatcher_id TEXT REFERENCES automatic_sms_dispatcher(id),
      template_id TEXT,
      template_version INTEGER,
      template_body TEXT,
      variables JSONB NOT NULL DEFAULT '{}'::jsonb,
      rendered_text TEXT NOT NULL,
      normalized_phone TEXT NOT NULL,
      scheduled_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      raw_body TEXT NOT NULL,
      signature TEXT NOT NULL,
      signature_timestamp TEXT NOT NULL,
      signature_nonce TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      status_reason TEXT,
      delivered_to_device_at TIMESTAMPTZ,
      authorization_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(partner_id, request_id),
      UNIQUE(partner_id, campaign_id, normalized_phone)
    );
    ALTER TABLE automatic_sms_request
      ADD COLUMN IF NOT EXISTS consent_reference TEXT;
    ALTER TABLE automatic_sms_request
      ADD COLUMN IF NOT EXISTS consent_captured_at TIMESTAMPTZ;
    ALTER TABLE automatic_sms_request
      ADD COLUMN IF NOT EXISTS consent_source TEXT;
    ALTER TABLE automatic_sms_request
      ADD COLUMN IF NOT EXISTS consent_version TEXT;
    ALTER TABLE automatic_sms_request ALTER COLUMN template_id DROP NOT NULL;
    ALTER TABLE automatic_sms_request ALTER COLUMN template_version DROP NOT NULL;
    ALTER TABLE automatic_sms_request ALTER COLUMN template_body DROP NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_automatic_sms_request_claim
      ON automatic_sms_request(dispatcher_id, delivered_to_device_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_automatic_sms_request_global_claim
      ON automatic_sms_request(delivered_to_device_at, scheduled_at, created_at)
      WHERE status IN ('PENDING','WAITING_ADVANCED_MODE','FAILED_RETRYABLE');
    CREATE INDEX IF NOT EXISTS idx_automatic_sms_request_status
      ON automatic_sms_request(status, updated_at);

    CREATE TABLE IF NOT EXISTS automatic_sms_event (
      event_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES automatic_sms_request(id) ON DELETE CASCADE,
      dispatcher_id TEXT REFERENCES automatic_sms_dispatcher(id),
      status TEXT NOT NULL,
      reason TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_automatic_sms_event_request
      ON automatic_sms_event(request_id, occurred_at);
    ALTER TABLE automatic_sms_event
      ALTER COLUMN dispatcher_id DROP NOT NULL;

    CREATE TABLE IF NOT EXISTS automatic_sms_ingress_audit (
      id BIGSERIAL PRIMARY KEY,
      partner_id TEXT,
      key_id TEXT,
      request_id TEXT,
      campaign_id TEXT,
      phone_hash CHAR(64),
      outcome TEXT NOT NULL,
      http_status INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_automatic_sms_ingress_audit_partner
      ON automatic_sms_ingress_audit(partner_id, created_at DESC);

    UPDATE automatic_sms_request r
       SET status='PENDING', status_reason=NULL, updated_at=now()
     WHERE r.expires_at>now()
       AND (
         (r.status='WAITING_DISPATCHER' AND r.status_reason='DISPATCHER_NOT_ASSIGNED')
         OR (r.status='BLOCKED' AND r.status_reason='DISPATCHER_REVOKED')
       )
       AND EXISTS(
         SELECT 1 FROM automatic_sms_partner p
          WHERE p.id=r.partner_id AND p.is_active=true
       )
       AND EXISTS(
         SELECT 1 FROM automatic_sms_partner_key k
          WHERE k.id=r.partner_key_id AND k.is_active=true
       );
  `);

  ready = true;
  console.log('[automatic-sms] schema verifie/applique');
}
