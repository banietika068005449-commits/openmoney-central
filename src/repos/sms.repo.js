import { pool } from '../db.js';

// SELECT join sms + sms_analysis qui produit exactement le shape attendu par
// le frontend (cf. frontend central/src/pages/SmsPage.jsx).
const COLUMNS = `
  s.id, s.sender, s.content, s.received_at, s.smsc_ts, s.status,
  s.point_de_vente,
  a.operator AS analysis_operator, a.amount, a.currency,
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
 * @param {{limit:number, offset:number, status?:string, smsType?:string, operator?:string, q?:string, sort?:'recent'|'ancient', period?:'all'|'days'|'week'}} f
 */
export async function listSms(f) {
  const where = [];
  const params = [];
  if (f.status)   { params.push(f.status);            where.push(`s.status = $${params.length}`); }
  if (f.operator) { params.push(f.operator);          where.push(`a.operator = $${params.length}`); }
  if (f.q)        { params.push(`%${f.q}%`);          where.push(`(s.sender ILIKE $${params.length} OR s.content ILIKE $${params.length})`); }
  if (f.period === 'days') {
    params.push(new Date(Date.now() - 24 * 60 * 60 * 1000));
    where.push(`s.received_at >= $${params.length}`);
  } else if (f.period === 'week') {
    params.push(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    where.push(`s.received_at >= $${params.length}`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const totalQ = await pool.query(
    `SELECT COUNT(*)::int AS n ${BASE_SELECT} ${whereSql}`,
    params,
  );

  // Ces indicateurs alimentent le dashboard admin. Ils portent toujours sur
  // l'ensemble des SMS et ne doivent donc reprendre ni les filtres ni la
  // pagination de la liste ci-dessous.
  const statsQ = await pool.query(`
    SELECT
      COUNT(*)::int AS total_sms,
      (COUNT(*) FILTER (WHERE s.status = 'analyzed'))::int AS analyzed,
      (COUNT(*) FILTER (WHERE s.status = 'failed'))::int AS failed,
      (COUNT(*) FILTER (WHERE s.status = 'ignored'))::int AS ignored,
      COALESCE(SUM(a.amount) FILTER (WHERE s.status = 'analyzed'), 0) AS deposit_sum
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
    `UPDATE sms SET status = $1 WHERE id = $2 RETURNING id, sender, content, received_at, smsc_ts, status`,
    [status, id],
  );
  return rows[0] ?? null;
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
