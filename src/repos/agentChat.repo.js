import { pool } from '../db.js';

const MESSAGE_COLUMNS = `
  id,
  agent_id,
  sender_type,
  body,
  read_at,
  created_at
`;

function normalizeLimit(limit, max = 200) {
  const n = Number(limit) || 100;
  return Math.min(Math.max(n, 1), max);
}

export async function listOpenChatConversations() {
  const { rows } = await pool.query(`
    SELECT
      a.id, a.name, a.city, a.phone, a.photo_url, a.is_active, a.last_login_at,
      latest.id AS last_message_id,
      latest.sender_type AS last_message_sender_type,
      latest.body AS last_message_body,
      latest.created_at AS last_message_created_at,
      COALESCE(unread.n, 0)::int AS unread_count
    FROM agent a
    LEFT JOIN LATERAL (
      SELECT id, sender_type, body, created_at
      FROM agent_chat_message m
      WHERE m.agent_id = a.id
      ORDER BY m.id DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS n
      FROM agent_chat_message m
      WHERE m.agent_id = a.id
        AND m.sender_type = 'agent'
        AND m.read_at IS NULL
    ) unread ON true
    ORDER BY
      latest.created_at DESC NULLS LAST,
      a.created_at DESC
  `);
  return rows;
}

export async function listOpenChatMessages(agentId, { after, limit } = {}) {
  const params = [agentId];
  const where = [`agent_id = $1`];
  const afterId = Number(after);
  if (Number.isFinite(afterId) && afterId > 0) {
    params.push(afterId);
    where.push(`id > $${params.length}`);
  }
  params.push(normalizeLimit(limit));
  const { rows } = await pool.query(
    `SELECT ${MESSAGE_COLUMNS}
     FROM agent_chat_message
     WHERE ${where.join(' AND ')}
     ORDER BY id ASC
     LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function createOpenChatMessage(agentId, senderType, body) {
  const normalizedBody = String(body || '').trim();
  if (!normalizedBody) return null;
  const { rows } = await pool.query(
    `INSERT INTO agent_chat_message (agent_id, sender_type, body)
     VALUES ($1, $2, $3)
     RETURNING ${MESSAGE_COLUMNS}`,
    [agentId, senderType, normalizedBody],
  );
  return rows[0] ?? null;
}

export async function markOpenChatRead(agentId, readerType) {
  const senderType = readerType === 'admin' ? 'agent' : 'admin';
  const { rowCount } = await pool.query(
    `UPDATE agent_chat_message
     SET read_at = COALESCE(read_at, now())
     WHERE agent_id = $1
       AND sender_type = $2
       AND read_at IS NULL`,
    [agentId, senderType],
  );
  return { updated: rowCount };
}

export async function countOpenChatUnreadForAgent(agentId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM agent_chat_message
     WHERE agent_id = $1
       AND sender_type = 'admin'
       AND read_at IS NULL`,
    [agentId],
  );
  return rows[0]?.n ?? 0;
}
