import { pool } from '../db.js';

/**
 * Cree une notification agent.
 * @param {{agentId:number, type:'flag_treated'|'archived_new_transaction', phoneNumber?:string, smsId?:number, transactionId?:string, message?:string}} n
 */
export async function createNotification({ agentId, type, phoneNumber, smsId, transactionId, message }) {
  const { rows } = await pool.query(
    `INSERT INTO agent_notification (agent_id, type, phone_number, sms_id, transaction_id, message)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, agent_id, type, phone_number, sms_id, transaction_id, message, is_read, created_at`,
    [agentId, type, phoneNumber ?? null, smsId ?? null, transactionId ?? null, message ?? ''],
  );
  return rows[0];
}

export async function listNotifications(agentId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, type, phone_number, sms_id, transaction_id, message, is_read, created_at
     FROM agent_notification
     WHERE agent_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [agentId, limit, offset],
  );
  return rows;
}

export async function unreadCount(agentId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM agent_notification WHERE agent_id = $1 AND is_read = false`,
    [agentId],
  );
  return rows[0].n;
}

export async function markRead(id, agentId) {
  const { rows } = await pool.query(
    `UPDATE agent_notification SET is_read = true
     WHERE id = $1 AND agent_id = $2
     RETURNING id, is_read`,
    [id, agentId],
  );
  return rows[0] ?? null;
}

export async function markAllRead(agentId) {
  await pool.query(
    `UPDATE agent_notification SET is_read = true WHERE agent_id = $1 AND is_read = false`,
    [agentId],
  );
}
