import { pool } from '../db.js';

// SELECT join sms + sms_analysis qui produit exactement le shape attendu par
// le frontend (cf. frontend central/src/pages/SmsPage.jsx).
const COLUMNS = `
  s.id, s.sender, s.content, s.received_at, s.smsc_ts, s.status,
  s.point_de_vente,
  a.operator AS analysis_operator, a.amount, a.balance, a.currency,
  a.phone_number, a.reference, a.transaction_id,
  a.extracted_data, a.analysis_status
`;

const BASE_SELECT = `
  FROM sms s
  LEFT JOIN sms_analysis a ON a.sms_id = s.id
`;

/**
 * Liste paginee + filtres. Renvoie items + total.
 *
 * @param {{limit:number, offset:number, status?:string, smsType?:string, operator?:string, q?:string}} f
 */
export async function listSms(f) {
  const where = [];
  const params = [];
  if (f.status)   { params.push(f.status);            where.push(`s.status = $${params.length}`); }
  if (f.operator) { params.push(f.operator);          where.push(`a.operator = $${params.length}`); }
  if (f.q)        { params.push(`%${f.q}%`);          where.push(`(s.sender ILIKE $${params.length} OR s.content ILIKE $${params.length})`); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const totalQ = await pool.query(
    `SELECT COUNT(*)::int AS n ${BASE_SELECT} ${whereSql}`,
    params,
  );

  params.push(f.limit, f.offset);
  const itemsQ = await pool.query(
    `SELECT ${COLUMNS} ${BASE_SELECT} ${whereSql}
     ORDER BY s.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { items: itemsQ.rows, total: totalQ.rows[0].n, limit: f.limit, offset: f.offset };
}

export async function getSmsById(id) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} ${BASE_SELECT} WHERE s.id = $1`,
    [id],
  );
  return rows[0] ?? null;
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
