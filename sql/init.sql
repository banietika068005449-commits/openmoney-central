CREATE TABLE IF NOT EXISTS sms (
  id          BIGSERIAL PRIMARY KEY,
  sender      TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  smsc_ts     TIMESTAMPTZ,
  modem_index INTEGER,
  raw         TEXT,
  status      TEXT        NOT NULL DEFAULT 'received'
);

CREATE INDEX IF NOT EXISTS idx_sms_received_at ON sms (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_sender      ON sms (sender);
CREATE INDEX IF NOT EXISTS idx_sms_status      ON sms (status);

-- Colonnes pour l'ingestion HTTP depuis les points de vente.
-- uuid       : identifiant emis par le PDV (utilise dans la reponse acceptes[]).
-- empreinte  : SHA-256 hex (64 chars) du triplet emetteur+message+horodatage, cle de dedup.
-- point_de_vente : identifiant du PDV ayant ingere la ligne en premier.
ALTER TABLE sms ADD COLUMN IF NOT EXISTS uuid           UUID;
ALTER TABLE sms ADD COLUMN IF NOT EXISTS empreinte      CHAR(64);
ALTER TABLE sms ADD COLUMN IF NOT EXISTS point_de_vente TEXT;

-- Indexes uniques sans predicate : PostgreSQL traite plusieurs NULL comme distincts
-- (donc les anciennes lignes sans uuid/empreinte restent autorisees) et ON CONFLICT
-- ne supporte l'inference que sur un index unique complet.
DROP INDEX IF EXISTS uq_sms_uuid;
DROP INDEX IF EXISTS uq_sms_empreinte;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_uuid      ON sms (uuid);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_empreinte ON sms (empreinte);
CREATE INDEX        IF NOT EXISTS idx_sms_pdv      ON sms (point_de_vente);

-- Resultat d'analyse pour chaque SMS. 1 ligne par sms_id (UNIQUE).
-- statut sms autorises : received | processing | analyzed | ignored | failed
CREATE TABLE IF NOT EXISTS sms_analysis (
  id              BIGSERIAL    PRIMARY KEY,
  sms_id          BIGINT       NOT NULL REFERENCES sms(id) ON DELETE CASCADE,
  provider        TEXT         NOT NULL,
  operator        TEXT,
  sms_type        TEXT         NOT NULL,
  amount          NUMERIC(14,2),
  balance         NUMERIC(14,2),
  currency        TEXT         DEFAULT 'FCFA',
  phone_number    TEXT,
  reference       TEXT,
  transaction_id  TEXT,
  confidence      NUMERIC(5,2) NOT NULL DEFAULT 0,
  extracted_data  JSONB        NOT NULL DEFAULT '{}'::jsonb,
  analysis_status TEXT         NOT NULL DEFAULT 'success',
  error_message   TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (sms_id)
);

CREATE INDEX IF NOT EXISTS idx_sms_analysis_sms_type ON sms_analysis (sms_type);
CREATE INDEX IF NOT EXISTS idx_sms_analysis_operator ON sms_analysis (operator);
CREATE INDEX IF NOT EXISTS idx_sms_analysis_created  ON sms_analysis (created_at DESC);

-- Providers AI (LLM) utilises en fallback intelligent pour l'analyse SMS.
-- provider_type autorises : openai | anthropic | google | mistral | custom
CREATE TABLE IF NOT EXISTS ai_provider (
  id            BIGSERIAL    PRIMARY KEY,
  name          TEXT         NOT NULL,
  provider_type TEXT         NOT NULL,
  model         TEXT         NOT NULL,
  base_url      TEXT,
  system_prompt TEXT,
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Migration idempotente pour ajouter system_prompt aux installations existantes
ALTER TABLE ai_provider ADD COLUMN IF NOT EXISTS system_prompt TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_provider_active ON ai_provider (is_active);
CREATE INDEX IF NOT EXISTS idx_ai_provider_type   ON ai_provider (provider_type);

-- Cles API multiples par provider. La selection est aleatoire parmi les actives.
CREATE TABLE IF NOT EXISTS ai_provider_key (
  id            BIGSERIAL    PRIMARY KEY,
  provider_id   BIGINT       NOT NULL REFERENCES ai_provider(id) ON DELETE CASCADE,
  label         TEXT,
  api_key       TEXT         NOT NULL,
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  last_used_at  TIMESTAMPTZ,
  usage_count   INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_provider_key_provider ON ai_provider_key (provider_id);
CREATE INDEX IF NOT EXISTS idx_ai_provider_key_active   ON ai_provider_key (is_active);
