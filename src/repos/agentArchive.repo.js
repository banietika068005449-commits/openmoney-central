import { pool } from '../db.js';

function normalizePhone(phone) {
  return String(phone || '').trim();
}

export async function listArchives(agentId) {
  const { rows } = await pool.query(
    `SELECT id, phone_number, created_at
     FROM agent_archive WHERE agent_id = $1 ORDER BY created_at DESC`,
    [agentId],
  );
  return rows;
}

/**
 * Archive un numero pour l'agent. Un numero ne peut etre archive que par UN
 * seul agent (unicite globale).
 * @returns {Promise<{ ok:true, archive } | { ok:false, reason:'invalid'|'taken', byAgentId?:number }>}
 */
export async function addArchive(agentId, phone) {
  const phoneNumber = normalizePhone(phone);
  if (!phoneNumber) return { ok: false, reason: 'invalid' };

  // Deja archive ?
  const existing = await pool.query(
    `SELECT id, agent_id, created_at FROM agent_archive WHERE phone_number = $1`,
    [phoneNumber],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (String(row.agent_id) === String(agentId)) {
      return { ok: true, archive: { id: row.id, phone_number: phoneNumber, created_at: row.created_at } };
    }
    return { ok: false, reason: 'taken', byAgentId: row.agent_id };
  }

  const { rows } = await pool.query(
    `INSERT INTO agent_archive (agent_id, phone_number)
     VALUES ($1, $2)
     RETURNING id, phone_number, created_at`,
    [agentId, phoneNumber],
  );
  return { ok: true, archive: rows[0] };
}

export async function removeArchive(agentId, phone) {
  const { rowCount } = await pool.query(
    `DELETE FROM agent_archive WHERE agent_id = $1 AND phone_number = $2`,
    [agentId, normalizePhone(phone)],
  );
  return rowCount > 0;
}

/** Ids des agents ayant archive ce numero (pour les notifications). */
export async function agentsArchiving(phone) {
  const phoneNumber = normalizePhone(phone);
  if (!phoneNumber) return [];
  const { rows } = await pool.query(
    `SELECT agent_id FROM agent_archive WHERE phone_number = $1`,
    [phoneNumber],
  );
  return rows.map((r) => r.agent_id);
}
