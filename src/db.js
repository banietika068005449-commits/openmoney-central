import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL manquant dans .env');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Statuts autorises pour sms.status :
//   received | processing | analyzed | ignored | failed
// (champ TEXT libre, pas de CHECK contraint cote DB.)

/**
 * Insertion d'un SMS dans la base A. Utilise par les tests d'integration
 * et par d'eventuels outils d'import. Le worker n'inserts pas lui-meme.
 */
export async function insertSms({ sender, content, smscTs, modemIndex, raw }) {
  const { rows } = await pool.query(
    `INSERT INTO sms (sender, content, smsc_ts, modem_index, raw)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, sender, content, received_at, smsc_ts, modem_index, status`,
    [sender, content, smscTs, modemIndex, raw],
  );
  return rows[0];
}

// ---- sms_analysis (base B) ----

/**
 * Upsert d'une ligne d'analyse. Utilise un client deja en transaction.
 * @param {import('pg').PoolClient} client
 * @param {number|string|bigint} smsId
 * @param {import('./analysis/types.js').SmsAnalysisResult} r
 */
export async function insertAnalysis(client, smsId, r) {
  await client.query(
    `INSERT INTO sms_analysis
       (sms_id, operator, amount, currency,
        phone_number, reference, transaction_id, extracted_data,
        analysis_status, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (sms_id) DO UPDATE SET
       operator        = EXCLUDED.operator,
       amount          = EXCLUDED.amount,
       currency        = EXCLUDED.currency,
       phone_number    = EXCLUDED.phone_number,
       reference       = EXCLUDED.reference,
       transaction_id  = EXCLUDED.transaction_id,
       extracted_data  = EXCLUDED.extracted_data,
       analysis_status = EXCLUDED.analysis_status,
       error_message   = EXCLUDED.error_message,
       created_at      = NOW()`,
    [
      smsId, r.operator ?? null,
      r.amount ?? null, r.currency ?? 'FCFA',
      r.phoneNumber ?? null, r.reference ?? null, r.transactionId ?? null,
      r.extractedData ?? {},
      r.analysisStatus, r.errorMessage ?? null,
    ],
  );
}

/** Retourne les ids de SMS a (re)traiter. */
export async function getPendingSmsIds({ limit = 50, statuses = ['received'] } = {}) {
  const { rows } = await pool.query(
    `SELECT id FROM sms
     WHERE status = ANY($1::text[])
     ORDER BY id ASC
     LIMIT $2`,
    [statuses, limit],
  );
  return rows.map((r) => r.id);
}

// ---- ai_provider (lecture seule depuis le worker) ----

/**
 * Selectionne aleatoirement un couple (provider, key) actifs.
 * Retourne null si rien n'est disponible.
 */
export async function pickRandomActiveProviderKey() {
  const { rows } = await pool.query(
    `SELECT p.id AS provider_id, p.name, p.provider_type, p.model, p.base_url,
            k.id AS key_id, k.api_key, k.label
     FROM ai_provider p
     JOIN ai_provider_key k ON k.provider_id = p.id
     WHERE p.is_active = true AND k.is_active = true
     ORDER BY RANDOM()
     LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Compteur d'usage (a appeler apres chaque appel reussi a une cle). */
export async function bumpKeyUsage(keyId) {
  await pool.query(
    `UPDATE ai_provider_key SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id=$1`,
    [keyId],
  );
}
