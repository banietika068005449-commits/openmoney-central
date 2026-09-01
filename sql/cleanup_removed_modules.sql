BEGIN;

DELETE FROM parametre WHERE cle = 'improvement_amount_rules';

DROP INDEX IF EXISTS idx_sms_analysis_imei;
ALTER TABLE IF EXISTS sms_analysis DROP COLUMN IF EXISTS imei;

ALTER TABLE IF EXISTS sms DROP COLUMN IF EXISTS admin_processing_status;
ALTER TABLE IF EXISTS sms DROP COLUMN IF EXISTS flagged_by_agent_id;
ALTER TABLE IF EXISTS sms DROP COLUMN IF EXISTS flagged_at;
ALTER TABLE IF EXISTS sms DROP COLUMN IF EXISTS flag_ack_at;
DROP TYPE IF EXISTS admin_processing_status_enum;

DROP TABLE IF EXISTS client_imei CASCADE;
DROP TABLE IF EXISTS transaction_badge CASCADE;
DROP TABLE IF EXISTS client_badge CASCADE;
DROP TABLE IF EXISTS client_manual_date CASCADE;

DROP TABLE IF EXISTS agent_chat_message CASCADE;
DROP TABLE IF EXISTS agent_notification CASCADE;
DROP TABLE IF EXISTS agent_archive CASCADE;
DROP TABLE IF EXISTS agent_session CASCADE;
DROP TABLE IF EXISTS agent CASCADE;

DROP TABLE IF EXISTS automatic_sms_event CASCADE;
DROP TABLE IF EXISTS automatic_sms_ingress_audit CASCADE;
DROP TABLE IF EXISTS automatic_sms_nonce CASCADE;
DROP TABLE IF EXISTS automatic_sms_request CASCADE;
DROP TABLE IF EXISTS automatic_sms_opt_out CASCADE;
DROP TABLE IF EXISTS automatic_sms_partner_template CASCADE;
DROP TABLE IF EXISTS automatic_sms_template CASCADE;
DROP TABLE IF EXISTS automatic_sms_partner_dispatcher CASCADE;
DROP TABLE IF EXISTS automatic_sms_dispatcher CASCADE;
DROP TABLE IF EXISTS automatic_sms_partner_key CASCADE;
DROP TABLE IF EXISTS automatic_sms_partner CASCADE;

COMMIT;
