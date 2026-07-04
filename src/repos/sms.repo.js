import { pool } from '../db.js';

// SELECT join sms + sms_analysis qui produit exactement le shape attendu par
// le frontend (cf. frontend central/src/pages/SmsPage.jsx).
const COLUMNS = `
  s.id, s.sender, s.content, s.received_at, s.smsc_ts, s.status,
  s.admin_processing_status,
  s.point_de_vente,
  a.operator AS analysis_operator, a.amount, a.currency,
  a.phone_number, COALESCE(a.imei, ci.imei) AS imei, a.reference, a.transaction_id,
  tn.note AS transaction_note,
  sn.note AS sms_note,
  tb.amount_rule_id AS transaction_badge_rule_id,
  a.extracted_data, a.analysis_status
`;

const BASE_SELECT = `
  FROM sms s
  LEFT JOIN sms_analysis a ON a.sms_id = s.id
  LEFT JOIN client_imei ci ON ci.phone_number = a.phone_number
  LEFT JOIN transaction_note tn ON tn.transaction_id = a.transaction_id
  LEFT JOIN sms_note sn ON sn.sms_id = s.id
  LEFT JOIN transaction_badge tb ON tb.transaction_id = a.transaction_id
`;

let smsAuxTablesReady = false;

async function ensureSmsAuxTables() {
  if (smsAuxTablesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sms_note (
      sms_id     BIGINT PRIMARY KEY REFERENCES sms(id) ON DELETE CASCADE,
      note       TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transaction_badge (
      transaction_id TEXT PRIMARY KEY,
      amount_rule_id TEXT NOT NULL DEFAULT '',
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  smsAuxTablesReady = true;
}

/**
 * Liste paginee + filtres. Renvoie items + total.
 *
 * @param {{limit:number, offset:number, status?:string, smsType?:string, operator?:string, phone?:string, transactionId?:string, amountRule?:number, q?:string, sort?:'recent'|'ancient', period?:'all'|'days'|'week', date?:string, hour?:number}} f
 */
export async function listSms(f) {
  await ensureSmsAuxTables();
  const where = [];
  const params = [];
  if (f.status)   { params.push(f.status);            where.push(`s.status = $${params.length}`); }
  if (f.operator) { params.push(f.operator);          where.push(`a.operator = $${params.length}`); }
  if (f.phone)    { params.push(`%${f.phone}%`);      where.push(`a.phone_number ILIKE $${params.length}`); }
  if (f.transactionId) { params.push(f.transactionId); where.push(`a.transaction_id = $${params.length}`); }
  if (f.amountRule) { params.push(f.amountRule);      where.push(`ROUND((a.amount)::numeric * 100)::bigint = $${params.length}`); }
  if (f.q)        { params.push(`%${f.q}%`);          where.push(`(s.sender ILIKE $${params.length} OR s.content ILIKE $${params.length})`); }
  if (f.period === 'days') {
    params.push(new Date(Date.now() - 24 * 60 * 60 * 1000));
    where.push(`s.received_at >= $${params.length}`);
  } else if (f.period === 'week') {
    params.push(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    where.push(`s.received_at >= $${params.length}`);
  }
  if (f.date && Number.isInteger(f.hour)) {
    const start = new Date(`${f.date}T${String(f.hour).padStart(2, '0')}:00:00+01:00`);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    params.push(start);
    where.push(`s.received_at >= $${params.length}`);
    params.push(end);
    where.push(`s.received_at < $${params.length}`);
  } else if (f.date) {
    const start = new Date(`${f.date}T00:00:00+01:00`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    params.push(start);
    where.push(`s.received_at >= $${params.length}`);
    params.push(end);
    where.push(`s.received_at < $${params.length}`);
  } else if (Number.isInteger(f.hour)) {
    params.push(f.hour);
    where.push(`EXTRACT(HOUR FROM s.received_at AT TIME ZONE 'Africa/Brazzaville') = $${params.length}`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const totalQ = await pool.query(
    `SELECT COUNT(*)::int AS n ${BASE_SELECT} ${whereSql}`,
    params,
  );

  // Ces indicateurs alimentent le dashboard admin. Ils portent toujours sur
  // l'ensemble des SMS et ne doivent donc reprendre ni les filtres ni la
  // pagination de la liste ci-dessous.
  // 'treated' est un sous-etat de 'analyzed' (depot analyse dont le numero a
  // ete copie). Il doit donc rester comptabilise dans le nombre d'analyses ET
  // dans la somme des depots : copier un numero ne doit jamais faire baisser le
  // montant total ni le compteur d'analyses.
  const statsQ = await pool.query(`
    SELECT
      COUNT(*)::int AS total_sms,
      (COUNT(*) FILTER (WHERE s.status IN ('analyzed', 'treated')))::int AS analyzed,
      (COUNT(*) FILTER (WHERE s.status = 'failed'))::int AS failed,
      (COUNT(*) FILTER (WHERE s.status = 'ignored'))::int AS ignored,
      COALESCE(SUM(a.amount) FILTER (WHERE s.status IN ('analyzed', 'treated')), 0) AS deposit_sum
    ${BASE_SELECT}
  `);

  params.push(f.limit, f.offset);
  const orderBy = f.sort === 'ancient' ? 's.received_at ASC' : 's.received_at DESC';
  const itemsQ = await pool.query(
    `SELECT ${COLUMNS} ${BASE_SELECT} ${whereSql}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const rawStats = statsQ.rows[0];
  return {
    items: itemsQ.rows,
    total: totalQ.rows[0].n,
    limit: f.limit,
    offset: f.offset,
    stats: {
      total: rawStats.total_sms,
      analyzed: rawStats.analyzed,
      failed: rawStats.failed,
      ignored: rawStats.ignored,
      sommeDepots: Number(rawStats.deposit_sum),
    },
  };
}

export async function setSmsStatus(id, status) {
  const { rows } = await pool.query(
    `UPDATE sms SET status = $1 WHERE id = $2 RETURNING id, sender, content, received_at, smsc_ts, status, admin_processing_status`,
    [status, id],
  );
  return rows[0] ?? null;
}

export async function setSmsAdminProcessingStatus(id, adminProcessingStatus) {
  const { rows } = await pool.query(
    `UPDATE sms SET admin_processing_status = $1 WHERE id = $2 RETURNING id, sender, content, received_at, smsc_ts, status, admin_processing_status`,
    [adminProcessingStatus, id],
  );
  return rows[0] ?? null;
}

export async function setSmsImei(id, imei) {
  const normalizedImei = String(imei || '').replace(/\D/g, '').slice(0, 32);
  const { rows } = await pool.query(
    `SELECT phone_number FROM sms_analysis WHERE sms_id = $1`,
    [id],
  );
  const phoneNumber = rows[0]?.phone_number || null;

  if (!normalizedImei) {
    if (phoneNumber) {
      await pool.query(`DELETE FROM client_imei WHERE phone_number = $1`, [phoneNumber]);
      await pool.query(`UPDATE sms_analysis SET imei = NULL WHERE phone_number = $1`, [phoneNumber]);
    } else {
      await pool.query(`UPDATE sms_analysis SET imei = NULL WHERE sms_id = $1`, [id]);
    }
  } else if (phoneNumber) {
    await pool.query(
      `INSERT INTO client_imei (phone_number, imei, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (phone_number) DO UPDATE SET
         imei = EXCLUDED.imei,
         updated_at = NOW()`,
      [phoneNumber, normalizedImei],
    );
    await pool.query(
      `UPDATE sms_analysis SET imei = $1 WHERE phone_number = $2`,
      [normalizedImei, phoneNumber],
    );
  } else {
    await pool.query(
      `UPDATE sms_analysis SET imei = $1 WHERE sms_id = $2`,
      [normalizedImei, id],
    );
  }

  return getSmsById(id);
}

export async function setTransactionNote(transactionId, note) {
  const normalizedTransactionId = String(transactionId || '').trim();
  const normalizedNote = String(note || '').trim();
  if (!normalizedTransactionId) return null;

  if (!normalizedNote) {
    await pool.query(`DELETE FROM transaction_note WHERE transaction_id = $1`, [normalizedTransactionId]);
    return { transaction_id: normalizedTransactionId, transaction_note: '' };
  }

  const { rows } = await pool.query(
    `INSERT INTO transaction_note (transaction_id, note, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (transaction_id) DO UPDATE SET
       note = EXCLUDED.note,
       updated_at = NOW()
     RETURNING transaction_id, note AS transaction_note`,
    [normalizedTransactionId, normalizedNote],
  );
  return rows[0] ?? null;
}

export async function setTransactionBadge(transactionId, amountRuleId) {
  await ensureSmsAuxTables();
  const normalizedTransactionId = String(transactionId || '').trim();
  const normalizedAmountRuleId = String(amountRuleId || '').trim();
  if (!normalizedTransactionId) return null;

  if (!normalizedAmountRuleId) {
    await pool.query(`DELETE FROM transaction_badge WHERE transaction_id = $1`, [normalizedTransactionId]);
    return { transaction_id: normalizedTransactionId, transaction_badge_rule_id: '' };
  }

  const { rows } = await pool.query(
    `INSERT INTO transaction_badge (transaction_id, amount_rule_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (transaction_id) DO UPDATE SET
       amount_rule_id = EXCLUDED.amount_rule_id,
       updated_at = NOW()
     RETURNING transaction_id, amount_rule_id AS transaction_badge_rule_id`,
    [normalizedTransactionId, normalizedAmountRuleId],
  );
  return rows[0] ?? null;
}

export async function getSmsById(id) {
  await ensureSmsAuxTables();
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} ${BASE_SELECT} WHERE s.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function setSmsNote(id, note) {
  await ensureSmsAuxTables();
  const normalizedNote = String(note || '').trim();

  if (!normalizedNote) {
    await pool.query(`DELETE FROM sms_note WHERE sms_id = $1`, [id]);
    return getSmsById(id);
  }

  await pool.query(
    `INSERT INTO sms_note (sms_id, note, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (sms_id) DO UPDATE SET
       note = EXCLUDED.note,
       updated_at = NOW()`,
    [id, normalizedNote],
  );
  return getSmsById(id);
}

export async function deleteSmsById(id) {
  const { rowCount } = await pool.query(`DELETE FROM sms WHERE id = $1`, [id]);
  return rowCount > 0;
}

/**
 * Force le statut a 'received' pour que analyzeOne() reprenne le SMS.
 * Renvoie true si le SMS existe.
 */
export async function resetForReanalyze(id) {
  const { rowCount } = await pool.query(
    `UPDATE sms SET status = 'received' WHERE id = $1`,
    [id],
  );
  return rowCount > 0;
}
