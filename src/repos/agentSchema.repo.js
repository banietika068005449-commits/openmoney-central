import { pool } from '../db.js';

// Applique le schema du module AGENT de maniere idempotente au demarrage.
// Render lance `npm start` (pas `npm run migrate`) : le schema doit donc
// s'auto-appliquer au runtime, comme ensureSmsAuxTables() cote sms.repo.js.
let ready = false;

export async function ensureAgentSchema() {
  if (ready) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent (
      id            BIGSERIAL   PRIMARY KEY,
      name          TEXT        NOT NULL,
      city          TEXT        NOT NULL,
      phone         TEXT        NOT NULL UNIQUE,
      pin_hash      TEXT,
      pin_salt      TEXT,
      must_set_pin  BOOLEAN     NOT NULL DEFAULT true,
      is_active     BOOLEAN     NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_session (
      id               BIGSERIAL   PRIMARY KEY,
      agent_id         BIGINT      NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
      token_hash       CHAR(64)    NOT NULL UNIQUE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at       TIMESTAMPTZ NOT NULL,
      revoked_at       TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_session_token_hash ON agent_session (token_hash)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_session_expires_at ON agent_session (expires_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_session_agent_id   ON agent_session (agent_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_archive (
      id           BIGSERIAL   PRIMARY KEY,
      agent_id     BIGINT      NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
      phone_number TEXT        NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (agent_id, phone_number)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_archive_phone ON agent_archive (phone_number)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_notification (
      id             BIGSERIAL   PRIMARY KEY,
      agent_id       BIGINT      NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
      type           TEXT        NOT NULL,
      phone_number   TEXT,
      sms_id         BIGINT,
      transaction_id TEXT,
      message        TEXT        NOT NULL DEFAULT '',
      is_read        BOOLEAN     NOT NULL DEFAULT false,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_notification_agent ON agent_notification (agent_id, is_read)`);

  await pool.query(`ALTER TABLE sms ADD COLUMN IF NOT EXISTS flagged_by_agent_id BIGINT`);
  await pool.query(`ALTER TABLE sms ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE sms ADD COLUMN IF NOT EXISTS flag_ack_at TIMESTAMPTZ`);

  // Un numero ne peut etre archive que par un seul agent (unicite globale).
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_archive_phone ON agent_archive (phone_number)`);

  // Statuts additionnels (ALTER TYPE hors transaction, idempotent).
  await pool.query(`ALTER TYPE admin_processing_status_enum ADD VALUE IF NOT EXISTS 'NOUVEAU'`);
  await pool.query(`ALTER TYPE admin_processing_status_enum ADD VALUE IF NOT EXISTS 'EN_ATTENTE'`);

  ready = true;
  console.log('[agent] schema verifie/applique');
}
