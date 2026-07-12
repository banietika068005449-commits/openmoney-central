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

export async function addArchive(agentId, phone) {
  const phoneNumber = normalizePhone(phone);
  if (!phoneNumber) return null;
  const { rows } = await pool.query(
    `INSERT INTO agent_archive (agent_id, phone_number)
     VALUES ($1, $2)
     ON CONFLICT (agent_id, phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
     RETURNING id, phone_number, created_at`,
    [agentId, phoneNumber],
  );
  return rows[0] ?? null;
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
