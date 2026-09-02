import { pool } from '../db.js';
import QueryStream from 'pg-query-stream';

// SELECT join sms + sms_analysis qui produit exactement le shape attendu par
// le frontend (cf. frontend central/src/pages/SmsPage.jsx).
const COLUMNS = `
  s.id, s.sender, s.content, s.received_at, s.smsc_ts, s.status,
  s.point_de_vente,
  a.operator AS analysis_operator, a.amount, a.currency,
  a.phone_number, a.reference, a.transaction_id,
  tn.note AS transaction_note,
  sn.note AS sms_note,
  (ct.phone_number IS NOT NULL) AS tecno,
  COALESCE(ct.auto, false) AS tecno_auto,
  a.extracted_data, a.analysis_status
`;

const BASE_SELECT = `
  FROM sms s
  LEFT JOIN sms_analysis a ON a.sms_id = s.id
  LEFT JOIN transaction_note tn ON tn.transaction_id = a.transaction_id
  LEFT JOIN sms_note sn ON sn.sms_id = s.id
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
 * Construit la clause SQL commune a la liste et aux exports afin qu'un meme
 * filtre retourne toujours exactement les memes transactions.
 */
export function buildSmsFilter(f = {}) {
  const where = [];
  const params = [];
  const addParam = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

  if (f.status)   { params.push(f.status);            where.push(`s.status = $${params.length}`); }
  if (f.operator) { params.push(f.operator);          where.push(`a.operator = $${params.length}`); }
  if (f.operatorPrefix === 'MTN') {
    where.push(`a.phone_number LIKE '06%'`);
  } else if (f.operatorPrefix === 'AIRTEL') {
    where.push(`(a.phone_number LIKE '05%' OR a.phone_number LIKE '04%')`);
  }
  if (f.phone) {
    const rawPhone = String(f.phone || '').trim();
    if (rawPhone) {
      const textParam = addParam(`%${rawPhone}%`);
      const parts = [
        `a.phone_number ILIKE ${textParam}`,
        `s.sender ILIKE ${textParam}`,
        `s.content ILIKE ${textParam}`,
      ];
      const phoneDigits = digitsOnly(rawPhone);
      if (phoneDigits) {
        const digitParam = addParam(`%${phoneDigits}%`);
        parts.push(
          `regexp_replace(COALESCE(a.phone_number, ''), '[^0-9]', '', 'g') LIKE ${digitParam}`,
          `regexp_replace(COALESCE(s.sender, ''), '[^0-9]', '', 'g') LIKE ${digitParam}`,
          `regexp_replace(COALESCE(s.content, ''), '[^0-9]', '', 'g') LIKE ${digitParam}`,
        );
      }
      where.push(`(${parts.join(' OR ')})`);
    }
  }
  if (f.transactionId) {
    const transactionId = String(f.transactionId || '').trim();
    if (transactionId) {
      const exactParam = addParam(transactionId);
      const textParam = addParam(`%${transactionId}%`);
      where.push(`(
        a.transaction_id = ${exactParam}
        OR s.uuid::text = ${exactParam}
        OR s.content ILIKE ${textParam}
        OR s.sender ILIKE ${textParam}
        OR a.reference ILIKE ${textParam}
      )`);
    }
  }
  if (f.hasNote)  { where.push(`(sn.note IS NOT NULL AND TRIM(sn.note) <> '')`); }
  if (f.tecno === 'only') where.push(`ct.phone_number IS NOT NULL`);
  else if (f.tecno === 'hide') where.push(`ct.phone_number IS NULL`);
  if (f.amount) { params.push(f.amount); where.push(`ROUND((a.amount)::numeric * 100)::bigint = $${params.length}`); }
  if (f.q) {
    const q = String(f.q || '').trim();
    if (q) {
      const textParam = addParam(`%${q}%`);
      const parts = [
        `s.sender ILIKE ${textParam}`,
        `s.content ILIKE ${textParam}`,
        `s.point_de_vente ILIKE ${textParam}`,
        `s.uuid::text ILIKE ${textParam}`,
        `a.phone_number ILIKE ${textParam}`,
        `a.transaction_id ILIKE ${textParam}`,
        `a.reference ILIKE ${textParam}`,
      ];
      const qDigits = digitsOnly(q);
      if (qDigits) {
        const digitParam = addParam(`%${qDigits}%`);
        parts.push(
          `regexp_replace(COALESCE(a.phone_number, ''), '[^0-9]', '', 'g') LIKE ${digitParam}`,
          `regexp_replace(COALESCE(s.sender, ''), '[^0-9]', '', 'g') LIKE ${digitParam}`,
          `regexp_replace(COALESCE(s.content, ''), '[^0-9]', '', 'g') LIKE ${digitParam}`,
        );
      }
      where.push(`(${parts.join(' OR ')})`);
    }
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

  return {
    whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '',
    params,
  };
}

function getSmsOrderBy(sort) {
  return sort === 'ancient' ? 's.received_at ASC, s.id ASC' : 's.received_at DESC, s.id DESC';
}

/**
 * Liste paginee + filtres. Renvoie items + total.
 *
 * @param {{limit:number, offset:number, status?:string, smsType?:string, operator?:string, operatorPrefix?:'MTN'|'AIRTEL', phone?:string, transactionId?:string, hasNote?:boolean, tecno?:'only'|'hide', amount?:number, q?:string, sort?:'recent'|'ancient', period?:'all'|'days'|'week', date?:string, hour?:number}} f
 */
export async function listSms(f) {
  await ensureSmsAuxTables();
  const { whereSql, params: filterParams } = buildSmsFilter(f);

  const totalQ = await pool.query(
    `SELECT COUNT(*)::int AS n ${BASE_SELECT} ${whereSql}`,
    filterParams,
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

  const params = [...filterParams, f.limit, f.offset];
  const orderBy = getSmsOrderBy(f.sort);
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
 * Flux stable de toutes les transactions filtrees. Le premier element contient
 * les metadonnees, les suivants contiennent une ligne. Le snapshot PostgreSQL
 * empeche les nouvelles transactions de deplacer les lignes pendant l'export.
 */
export async function* streamSmsForExport(f, { batchSize = 250 } = {}) {
  await ensureSmsAuxTables();
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionOpen = true;
    const { whereSql, params } = buildSmsFilter(f);
    const totalQ = await client.query(
      `SELECT COUNT(*)::int AS n ${BASE_SELECT} ${whereSql}`,
      params,
    );
    const total = Number(totalQ.rows[0]?.n || 0);
    yield { type: 'meta', total };

    if (total > 0) {
      const orderBy = getSmsOrderBy(f.sort);
      const query = new QueryStream(
        `SELECT ${COLUMNS},
           COUNT(*) OVER (PARTITION BY NULLIF(TRIM(a.phone_number), ''))::int AS duplicate_count
         ${BASE_SELECT} ${whereSql}
         ORDER BY ${orderBy}`,
        params,
        { batchSize },
      );
      const rows = client.query(query);
      for await (const row of rows) {
        yield { type: 'row', row };
      }
    }

    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      transactionOpen = false;
    }
    throw error;
  } finally {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* connection is being released */ }
    }
    client.release();
  }
}

export async function setSmsStatus(id, status) {
  const { rows } = await pool.query(
    `UPDATE sms SET status = $1 WHERE id = $2 RETURNING id, sender, content, received_at, smsc_ts, status`,
    [status, id],
  );
  return rows[0] ?? null;
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
