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
      template_id TEXT NOT NULL,
      template_version INTEGER NOT NULL,
      template_body TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_automatic_sms_request_claim
      ON automatic_sms_request(dispatcher_id, delivered_to_device_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_automatic_sms_request_status
      ON automatic_sms_request(status, updated_at);

    CREATE TABLE IF NOT EXISTS automatic_sms_event (
      event_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES automatic_sms_request(id) ON DELETE CASCADE,
      dispatcher_id TEXT NOT NULL REFERENCES automatic_sms_dispatcher(id),
      status TEXT NOT NULL,
      reason TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_automatic_sms_event_request
      ON automatic_sms_event(request_id, occurred_at);
  `);

  await pool.query(
    `INSERT INTO automatic_sms_partner(id, name)
     VALUES ('tecno_ya_niongo', 'Tecno Ya Niongo')
     ON CONFLICT (id) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO automatic_sms_template(id, version, body, variable_schema)
     VALUES (
       'payment_app_download_v1',
       1,
       'Bonjour {{customerName}}, utilisez l''application OpenMoney pour consulter et regler votre echeance.',
       '{"customerName":{"required":true,"maxLength":80}}'::jsonb
     )
     ON CONFLICT (id, version) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO automatic_sms_template(id, version, body, variable_schema)
     VALUES (
       'contract_app_download_v1',
       1,
       'Bonjour {{customerName}}, votre contrat appareil Tecno est enregistre. Telechargez OpenMoney pour suivre vos echeances : {{openMoneyDownloadUrl}}',
       '{"customerName":{"required":true,"maxLength":80}}'::jsonb
     )
     ON CONFLICT (id, version) DO NOTHING`,
  );
  ready = true;
  console.log('[automatic-sms] schema verifie/applique');
}
