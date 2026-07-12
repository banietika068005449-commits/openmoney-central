DO $$ BEGIN
  CREATE TYPE admin_processing_status_enum AS ENUM ('ANALYSIS', 'UNLOCKED', 'TREATED', 'PROBLEM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS sms (
  id          BIGSERIAL PRIMARY KEY,
  sender      TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  smsc_ts     TIMESTAMPTZ,
  modem_index INTEGER,
  raw         TEXT,
  status      TEXT        NOT NULL DEFAULT 'received',
  admin_processing_status admin_processing_status_enum NOT NULL DEFAULT 'ANALYSIS'
);

ALTER TABLE sms ADD COLUMN IF NOT EXISTS admin_processing_status admin_processing_status_enum NOT NULL DEFAULT 'ANALYSIS';

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
  imei            TEXT,
  reference       TEXT,
  transaction_id  TEXT,
  confidence      NUMERIC(5,2) NOT NULL DEFAULT 0,
  extracted_data  JSONB        NOT NULL DEFAULT '{}'::jsonb,
  analysis_status TEXT         NOT NULL DEFAULT 'success',
  error_message   TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (sms_id)
);

CREATE INDEX IF NOT EXISTS idx_sms_analysis_operator ON sms_analysis (operator);
CREATE INDEX IF NOT EXISTS idx_sms_analysis_created  ON sms_analysis (created_at DESC);
ALTER TABLE sms_analysis ADD COLUMN IF NOT EXISTS imei TEXT;
CREATE INDEX IF NOT EXISTS idx_sms_analysis_phone_number ON sms_analysis (phone_number);
CREATE INDEX IF NOT EXISTS idx_sms_analysis_imei ON sms_analysis (imei);

-- IMEI connu par client. Permet d'afficher l'IMEI sur les prochaines
-- transactions du meme numero meme si l'analyse du SMS ne le porte pas.
CREATE TABLE IF NOT EXISTS client_imei (
  phone_number TEXT PRIMARY KEY,
  imei         TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Notes administratives attachees au numero de transaction.
CREATE TABLE IF NOT EXISTS transaction_note (
  transaction_id TEXT PRIMARY KEY,
  note           TEXT NOT NULL DEFAULT '',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Notes administratives attachees a une ligne SMS precise.
CREATE TABLE IF NOT EXISTS sms_note (
  sms_id     BIGINT PRIMARY KEY REFERENCES sms(id) ON DELETE CASCADE,
  note       TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Badge manuel attache au numero de transaction. La valeur reference une
-- regle du module Amelioration (amountRules[].id).
CREATE TABLE IF NOT EXISTS transaction_badge (
  transaction_id TEXT PRIMARY KEY,
  amount_rule_id TEXT NOT NULL DEFAULT '',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Echeance connue par client. Elle s'applique aux anciennes et futures
-- transactions du meme numero client.
CREATE TABLE IF NOT EXISTS client_badge (
  phone_number   TEXT PRIMARY KEY,
  amount_rule_id TEXT NOT NULL DEFAULT '',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO client_badge (phone_number, amount_rule_id, updated_at)
SELECT DISTINCT ON (a.phone_number)
  a.phone_number,
  tb.amount_rule_id,
  tb.updated_at
FROM transaction_badge tb
JOIN sms_analysis a ON a.transaction_id = tb.transaction_id
WHERE a.phone_number IS NOT NULL
  AND TRIM(a.phone_number) <> ''
  AND tb.amount_rule_id IS NOT NULL
  AND TRIM(tb.amount_rule_id) <> ''
ORDER BY a.phone_number, tb.updated_at DESC
ON CONFLICT (phone_number) DO NOTHING;

-- Numeros marques TECNO en permanence (Liste TECNO du module dedie).
--   auto=true   : numero verrouille (saisi manuellement OU importe du partenaire).
--   source      : 'manual' (saisie admin) | 'partner' (API Tecno Ya Niongo).
--   fetched_at  : horodatage du dernier import partenaire.
-- (Table egalement geree/migree par ensureSmsAuxTables() dans sms.repo.js.)
CREATE TABLE IF NOT EXISTS client_tecno (
  phone_number TEXT PRIMARY KEY,
  auto         BOOLEAN NOT NULL DEFAULT false,
  source       TEXT NOT NULL DEFAULT 'manual',
  fetched_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE client_tecno ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE client_tecno ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ;

-- Suppression des colonnes inutiles cote metier :
--   - provider, confidence : debug technique, non consomme par l'UI
--   - sms_type : OpenMoney ne traite que les depots, le reste est ignored
--   - balance : le solde est global (carte SIM partagee), pas individuel.
--     OpenMoney ne stocke que le montant verse par chaque client.
ALTER TABLE sms_analysis DROP COLUMN IF EXISTS provider;
ALTER TABLE sms_analysis DROP COLUMN IF EXISTS confidence;
DROP INDEX IF EXISTS idx_sms_analysis_sms_type;
ALTER TABLE sms_analysis DROP COLUMN IF EXISTS sms_type;
ALTER TABLE sms_analysis DROP COLUMN IF EXISTS balance;

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

-- Simplification du modele AI :
--   - system_prompt n'est plus un champ par provider, mais un parametre global
--     (cf. table parametre ci-dessous + cle 'system_prompt'). Un seul prompt
--     systeme pour tous les providers, edite depuis le dashboard.
--   - name n'est plus obligatoire : l'API auto-genere "${providerType}/${model}"
--     si non fourni.
ALTER TABLE ai_provider DROP COLUMN IF EXISTS system_prompt;
ALTER TABLE ai_provider ALTER COLUMN name DROP NOT NULL;

-- Parametres globaux (cle/valeur). Cles utilisees :
--   system_prompt : prompt systeme partage par les analyseurs LLM.
--   recaptcha_enabled : active/desactive la verification reCAPTCHA au login admin.
--   recaptcha_site_key / recaptcha_secret_key : cles Google reCAPTCHA v2.
--   improvement_amount_rules : regles couleur/montant du module Amelioration.
CREATE TABLE IF NOT EXISTS parametre (
    cle             VARCHAR(64) PRIMARY KEY,
    valeur          TEXT,
    mis_a_jour_le   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Jetons d'acces au dashboard. Le secret brut n'est jamais conserve : seule
-- son empreinte SHA-256 permet de verifier les requetes entrantes.
CREATE TABLE IF NOT EXISTS access_token (
    id              BIGSERIAL    PRIMARY KEY,
    label           VARCHAR(120) NOT NULL,
    token_hash      CHAR(64)     NOT NULL UNIQUE,
    token_prefix    VARCHAR(24)  NOT NULL,
    is_active       BOOLEAN      NOT NULL DEFAULT true,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_access_token_active ON access_token (is_active);

CREATE TABLE IF NOT EXISTS admin_session (
    id                 BIGSERIAL    PRIMARY KEY,
    token_hash         CHAR(64)     NOT NULL UNIQUE,
    admin_type         VARCHAR(32)  NOT NULL,
    access_token_id    BIGINT,
    access_token_label VARCHAR(120),
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_activity_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at         TIMESTAMPTZ  NOT NULL,
    revoked_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_session_token_hash ON admin_session (token_hash);
CREATE INDEX IF NOT EXISTS idx_admin_session_expires_at ON admin_session (expires_at);

CREATE TABLE IF NOT EXISTS push_subscription (
    id            BIGSERIAL PRIMARY KEY,
    user_id       TEXT,
    endpoint      TEXT NOT NULL UNIQUE,
    p256dh        TEXT NOT NULL,
    auth          TEXT NOT NULL,
    user_agent    TEXT,
    device_name   TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_subscription_active ON push_subscription (is_active);
CREATE INDEX IF NOT EXISTS idx_push_subscription_user_id ON push_subscription (user_id);

-- ===========================================================================
-- Module AGENT : application mobile des agents (verification des paiements).
-- ===========================================================================

-- Un agent est cree par l'admin (name, city, phone). Le PIN est choisi par
-- l'agent lui-meme a la 1ere connexion (must_set_pin=true tant qu'il est vide).
--   pin_hash / pin_salt : PBKDF2 (hex). NULL tant que le PIN n'est pas defini.
--   L'admin peut reinitialiser le PIN (efface hash/sel + must_set_pin=true).
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
);

-- Sessions agent (miroir de admin_session). Token opaque hache en SHA-256.
CREATE TABLE IF NOT EXISTS agent_session (
    id               BIGSERIAL   PRIMARY KEY,
    agent_id         BIGINT      NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    token_hash       CHAR(64)    NOT NULL UNIQUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NOT NULL,
    revoked_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_session_token_hash ON agent_session (token_hash);
CREATE INDEX IF NOT EXISTS idx_agent_session_expires_at ON agent_session (expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_session_agent_id   ON agent_session (agent_id);

-- Numeros archives par un agent (acces rapide + declencheur de notification
-- sur nouvelle transaction).
CREATE TABLE IF NOT EXISTS agent_archive (
    id           BIGSERIAL   PRIMARY KEY,
    agent_id     BIGINT      NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    phone_number TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agent_id, phone_number)
);

CREATE INDEX IF NOT EXISTS idx_agent_archive_phone ON agent_archive (phone_number);

-- Notifications agent (alimentees par polling cote app).
--   type : 'flag_treated' | 'archived_new_transaction'
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
);

CREATE INDEX IF NOT EXISTS idx_agent_notification_agent ON agent_notification (agent_id, is_read);

-- Signalement d'une transaction par un agent : on retient qui a signale pour
-- pouvoir le notifier quand l'admin traite le SMS (admin_processing_status).
ALTER TABLE sms ADD COLUMN IF NOT EXISTS flagged_by_agent_id BIGINT;
ALTER TABLE sms ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ;
