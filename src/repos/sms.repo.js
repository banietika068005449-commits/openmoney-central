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
  CASE WHEN cb.phone_number IS NOT NULL THEN cb.amount_rule_id ELSE tb.amount_rule_id END AS transaction_badge_rule_id,
  TO_CHAR(cmd.manual_date, 'YYYY-MM-DD') AS transaction_manual_date,
  (ct.phone_number IS NOT NULL) AS tecno,
  COALESCE(ct.auto, false) AS tecno_auto,
  a.extracted_data, a.analysis_status
`;

const BASE_SELECT = `
  FROM sms s
  LEFT JOIN sms_analysis a ON a.sms_id = s.id
  LEFT JOIN client_imei ci ON ci.phone_number = a.phone_number
  LEFT JOIN transaction_note tn ON tn.transaction_id = a.transaction_id
  LEFT JOIN sms_note sn ON sn.sms_id = s.id
  LEFT JOIN transaction_badge tb ON tb.transaction_id = a.transaction_id
  LEFT JOIN client_badge cb ON cb.phone_number = a.phone_number
  LEFT JOIN client_manual_date cmd ON cmd.phone_number = a.phone_number
  LEFT JOIN client_tecno ct ON ct.phone_number = a.phone_number
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_badge (
      phone_number   TEXT PRIMARY KEY,
      amount_rule_id TEXT NOT NULL DEFAULT '',
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
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
    ON CONFLICT (phone_number) DO NOTHING
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_manual_date (
      phone_number TEXT PRIMARY KEY,
      manual_date  DATE,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_tecno (
      phone_number TEXT PRIMARY KEY,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE client_tecno ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT false`);
  // Origine du numero force : 'manual' (saisi via le module TECNO) ou 'partner'
  // (importe automatiquement depuis l'API Tecno Ya Niongo). fetched_at = horodatage
  // du dernier import partenaire.
  await pool.query(`ALTER TABLE client_tecno ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'`);
  await pool.query(`ALTER TABLE client_tecno ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ`);
  smsAuxTablesReady = true;
}

/**
 * Liste paginee + filtres. Renvoie items + total.
 *
 * @param {{limit:number, offset:number, status?:string, smsType?:string, operator?:string, operatorPrefix?:'MTN'|'AIRTEL', phone?:string, transactionId?:string, imei?:string, hasNote?:boolean, tecno?:'only'|'hide', amount?:number, amountRule?:number, q?:string, sort?:'recent'|'ancient', period?:'all'|'days'|'week', date?:string, hour?:number}} f
 */
export async function listSms(f) {
  await ensureSmsAuxTables();
  const where = [];
  const params = [];
  if (f.status)   { params.push(f.status);            where.push(`s.status = $${params.length}`); }
  if (f.operator) { params.push(f.operator);          where.push(`a.operator = $${params.length}`); }
  if (f.operatorPrefix === 'MTN') {
    where.push(`a.phone_number LIKE '06%'`);
  } else if (f.operatorPrefix === 'AIRTEL') {
    where.push(`(a.phone_number LIKE '05%' OR a.phone_number LIKE '04%')`);
  }
  if (f.phone)    { params.push(`%${f.phone}%`);      where.push(`a.phone_number ILIKE $${params.length}`); }
  if (f.transactionId) { params.push(f.transactionId); where.push(`a.transaction_id = $${params.length}`); }
  if (f.imei)     { params.push(`%${f.imei}%`);       where.push(`COALESCE(a.imei, ci.imei) ILIKE $${params.length}`); }
  if (f.hasImei)  { where.push(`(COALESCE(a.imei, ci.imei) IS NOT NULL AND TRIM(COALESCE(a.imei, ci.imei)) <> '')`); }
  if (f.hasNote)  { where.push(`(sn.note IS NOT NULL AND TRIM(sn.note) <> '')`); }
  if (f.tecno === 'only') where.push(`ct.phone_number IS NOT NULL`);
  else if (f.tecno === 'hide') where.push(`ct.phone_number IS NULL`);
  if (f.amount) { params.push(f.amount);              where.push(`ROUND((a.amount)::numeric * 100)::bigint = $${params.length}`); }
  if (f.amountRule) { params.push(f.amountRule);      where.push(`ROUND((a.amount)::numeric * 100)::bigint = $${params.length}`); }
  if (f.q) {
    params.push(`%${f.q}%`);
    where.push(`(
      s.sender ILIKE $${params.length}
      OR s.content ILIKE $${params.length}
      OR a.phone_number ILIKE $${params.length}
      OR a.transaction_id ILIKE $${params.length}
      OR a.reference ILIKE $${params.length}
    )`);
  }
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

/**
 * Toutes les transactions dont le numero est archive par cet agent (jointure
 * sms + sms_analysis), triees recentes d'abord. Reutilise COLUMNS/BASE_SELECT.
 * Renvoie { items, total }.
 */
export async function listArchivedTransactions(agentId, { limit = 200, offset = 0 } = {}) {
  await ensureSmsAuxTables();
  const where = `WHERE a.phone_number IN (SELECT phone_number FROM agent_archive WHERE agent_id = $1)`;
  const totalQ = await pool.query(
    `SELECT COUNT(*)::int AS n ${BASE_SELECT} ${where}`,
    [agentId],
  );
  const itemsQ = await pool.query(
    `SELECT ${COLUMNS} ${BASE_SELECT} ${where}
     ORDER BY s.received_at DESC
     LIMIT $2 OFFSET $3`,
    [agentId, limit, offset],
  );
  return { items: itemsQ.rows, total: totalQ.rows[0].n };
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
    `UPDATE sms SET admin_processing_status = $1 WHERE id = $2
     RETURNING id, sender, content, received_at, smsc_ts, status, admin_processing_status,
               flagged_by_agent_id`,
    [adminProcessingStatus, id],
  );
  return rows[0] ?? null;
}

/**
 * Signalement d'une transaction par un agent : passe le SMS en PROBLEM (rouge
 * cote admin) et memorise l'agent signalant pour le notifier au traitement.
 * Renvoie { id, phone_number, transaction_id } ou null si SMS introuvable.
 */
export async function flagSmsByAgent(id, agentId) {
  // Re-signalement autorise : on remet flag_ack_at a NULL pour re-declencher
  // l'alerte flottante cote admin.
  const { rows } = await pool.query(
    `UPDATE sms s
     SET admin_processing_status = 'PROBLEM',
         flagged_by_agent_id = $2,
         flagged_at = NOW(),
         flag_ack_at = NULL
     FROM sms_analysis a
     WHERE s.id = $1 AND a.sms_id = s.id
     RETURNING s.id, a.phone_number, a.transaction_id`,
    [id, agentId],
  );
  if (rows[0]) return rows[0];
  const { rows: bare } = await pool.query(
    `UPDATE sms SET admin_processing_status = 'PROBLEM', flagged_by_agent_id = $2, flagged_at = NOW(), flag_ack_at = NULL
     WHERE id = $1 RETURNING id`,
    [id, agentId],
  );
  return bare[0] ? { id: bare[0].id, phone_number: null, transaction_id: null } : null;
}

/** Efface le marqueur de signalement (apres notification de l'agent). */
export async function clearSmsFlag(id) {
  await pool.query(
    `UPDATE sms SET flagged_by_agent_id = NULL, flagged_at = NULL WHERE id = $1`,
    [id],
  );
}

/** Signalements en attente de prise en compte admin (alerte flottante). */
export async function listPendingFlags() {
  await ensureSmsAuxTables();
  const { rows } = await pool.query(
    `SELECT s.id, s.flagged_at, s.flagged_by_agent_id AS agent_id,
            ag.name AS agent_name,
            a.phone_number, a.amount, a.transaction_id
     FROM sms s
     LEFT JOIN sms_analysis a ON a.sms_id = s.id
     LEFT JOIN agent ag ON ag.id = s.flagged_by_agent_id
     WHERE s.flagged_by_agent_id IS NOT NULL AND s.flag_ack_at IS NULL
     ORDER BY s.flagged_at ASC
     LIMIT 20`,
  );
  return rows;
}

/** Marque un signalement comme pris en compte. Renvoie { agent_id, phone_number, transaction_id }. */
export async function ackSmsFlag(id) {
  const { rows } = await pool.query(
    `UPDATE sms s
     SET flag_ack_at = NOW()
     FROM sms_analysis a
     WHERE s.id = $1 AND a.sms_id = s.id AND s.flagged_by_agent_id IS NOT NULL
     RETURNING s.flagged_by_agent_id AS agent_id, a.phone_number, a.transaction_id`,
    [id],
  );
  if (rows[0]) return rows[0];
  const { rows: bare } = await pool.query(
    `UPDATE sms SET flag_ack_at = NOW()
     WHERE id = $1 AND flagged_by_agent_id IS NOT NULL
     RETURNING flagged_by_agent_id AS agent_id`,
    [id],
  );
  return bare[0] ? { agent_id: bare[0].agent_id, phone_number: null, transaction_id: null } : null;
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

export async function setSmsEcheance(id, amountRuleId) {
  await ensureSmsAuxTables();
  const normalizedAmountRuleId = String(amountRuleId || '').trim();
  const { rows } = await pool.query(
    `SELECT phone_number FROM sms_analysis WHERE sms_id = $1`,
    [id],
  );
  const phoneNumber = String(rows[0]?.phone_number || '').trim();
  if (!phoneNumber) return null;

  if (!normalizedAmountRuleId) {
    await pool.query(
      `INSERT INTO client_badge (phone_number, amount_rule_id, updated_at)
       VALUES ($1, '', NOW())
       ON CONFLICT (phone_number) DO UPDATE SET
         amount_rule_id = '',
         updated_at = NOW()`,
      [phoneNumber],
    );
    return { sms_id: Number(id), phone_number: phoneNumber, transaction_badge_rule_id: '' };
  }

  const result = await pool.query(
    `INSERT INTO client_badge (phone_number, amount_rule_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (phone_number) DO UPDATE SET
       amount_rule_id = EXCLUDED.amount_rule_id,
       updated_at = NOW()
     RETURNING phone_number, amount_rule_id AS transaction_badge_rule_id`,
    [phoneNumber, normalizedAmountRuleId],
  );
  return { sms_id: Number(id), ...result.rows[0] };
}

export async function setManualDate(id, isoDate) {
  await ensureSmsAuxTables();
  const normalizedDate = String(isoDate || '').trim();
  const { rows } = await pool.query(
    `SELECT phone_number FROM sms_analysis WHERE sms_id = $1`,
    [id],
  );
  const phoneNumber = String(rows[0]?.phone_number || '').trim();
  if (!phoneNumber) return null;

  if (!normalizedDate) {
    await pool.query(`DELETE FROM client_manual_date WHERE phone_number = $1`, [phoneNumber]);
    return { sms_id: Number(id), phone_number: phoneNumber, transaction_manual_date: null };
  }

  const result = await pool.query(
    `INSERT INTO client_manual_date (phone_number, manual_date, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (phone_number) DO UPDATE SET
       manual_date = EXCLUDED.manual_date,
       updated_at = NOW()
     RETURNING phone_number, TO_CHAR(manual_date, 'YYYY-MM-DD') AS transaction_manual_date`,
    [phoneNumber, normalizedDate],
  );
  return { sms_id: Number(id), ...result.rows[0] };
}

export async function setTecno(id, marked) {
  await ensureSmsAuxTables();
  const { rows } = await pool.query(
    `SELECT phone_number FROM sms_analysis WHERE sms_id = $1`,
    [id],
  );
  const phoneNumber = String(rows[0]?.phone_number || '').trim();
  if (!phoneNumber) return null;

  if (marked) {
    await pool.query(
      `INSERT INTO client_tecno (phone_number, auto, updated_at)
       VALUES ($1, false, NOW())
       ON CONFLICT (phone_number) DO NOTHING`,
      [phoneNumber],
    );
  } else {
    // Ne jamais retirer un numero force (auto=true) : sa case est verrouillee cote UI.
    await pool.query(`DELETE FROM client_tecno WHERE phone_number = $1 AND auto = false`, [phoneNumber]);
  }
  return { sms_id: Number(id), phone_number: phoneNumber, tecno: !!marked };
}

// ---- Liste TECNO forcee (numeros toujours coches, geree par le module dedie) ----

function normalizeTecnoPhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

export async function listForcedTecno() {
  await ensureSmsAuxTables();
  const { rows } = await pool.query(
    `SELECT phone_number, updated_at, source, fetched_at
       FROM client_tecno WHERE auto = true ORDER BY updated_at DESC`,
  );
  return { items: rows };
}

/** Compte les numeros forces par origine (pour le panneau de statut de synchro). */
export async function countForcedTecnoBySource() {
  await ensureSmsAuxTables();
  const { rows } = await pool.query(
    `SELECT source, COUNT(*)::int AS n FROM client_tecno WHERE auto = true GROUP BY source`,
  );
  const counts = { manual: 0, partner: 0, total: 0 };
  for (const r of rows) {
    if (r.source === 'partner') counts.partner = r.n;
    else counts.manual += r.n;
    counts.total += r.n;
  }
  return counts;
}

/**
 * UPSERT groupe et idempotent d'une liste de numeros importes du partenaire Tecno.
 * Normalise + filtre (6..15 chiffres) + dedup via Set avant insertion.
 * Un numero deja present (meme 'manual') devient 'partner' et reste auto=true.
 * @param {string[]} phoneNumbers
 * @returns {Promise<{ upserted: number }>}
 */
export async function upsertPartnerTecnoNumbers(phoneNumbers) {
  await ensureSmsAuxTables();
  const unique = new Set();
  for (const raw of phoneNumbers || []) {
    const n = normalizeTecnoPhone(raw);
    if (n.length >= 6 && n.length <= 15) unique.add(n);
  }
  const list = [...unique];
  if (list.length === 0) return { upserted: 0 };

  const { rowCount } = await pool.query(
    `INSERT INTO client_tecno (phone_number, auto, source, fetched_at, updated_at)
     SELECT n, true, 'partner', NOW(), NOW() FROM unnest($1::text[]) AS n
     ON CONFLICT (phone_number) DO UPDATE SET
       auto       = true,
       source     = 'partner',
       fetched_at = NOW(),
       updated_at = NOW()`,
    [list],
  );
  return { upserted: rowCount };
}

export async function addForcedTecno(phone) {
  await ensureSmsAuxTables();
  const phoneNumber = normalizeTecnoPhone(phone);
  if (phoneNumber.length < 6 || phoneNumber.length > 15) return null;
  const { rows } = await pool.query(
    `INSERT INTO client_tecno (phone_number, auto, updated_at)
     VALUES ($1, true, NOW())
     ON CONFLICT (phone_number) DO UPDATE SET auto = true, updated_at = NOW()
     RETURNING phone_number, updated_at`,
    [phoneNumber],
  );
  return rows[0];
}

export async function removeForcedTecno(phone) {
  await ensureSmsAuxTables();
  const phoneNumber = normalizeTecnoPhone(phone);
  const { rowCount } = await pool.query(
    `DELETE FROM client_tecno WHERE phone_number = $1 AND auto = true`,
    [phoneNumber],
  );
  return rowCount > 0;
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
