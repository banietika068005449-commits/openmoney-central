import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db.js';

export function getAgentSessionTtlMs() {
  const hours = Number(process.env.AGENT_SESSION_TTL_HOURS || 720); // 30 jours par defaut
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 720;
  return safeHours * 60 * 60 * 1000;
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function createAgentSession(agentId) {
  const token = `om_asess_${randomBytes(32).toString('base64url')}`;
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + getAgentSessionTtlMs());
  const { rows } = await pool.query(
    `INSERT INTO agent_session (agent_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, agent_id, created_at, last_activity_at, expires_at`,
    [agentId, tokenHash, expiresAt],
  );
  return { token, session: rows[0] };
}

export async function consumeAgentSession(token) {
  const tokenHash = hashSessionToken(token);
  const { rows } = await pool.query(
    `SELECT s.id, s.agent_id, s.created_at, s.last_activity_at, s.expires_at, s.revoked_at,
            a.is_active AS agent_active
     FROM agent_session s
     JOIN agent a ON a.id = s.agent_id
     WHERE s.token_hash = $1
     LIMIT 1`,
    [tokenHash],
  );

  const session = rows[0];
  if (!session || session.revoked_at) return { ok: false, reason: 'invalid' };
  if (!session.agent_active) return { ok: false, reason: 'invalid' };

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await revokeAgentSession(token);
    return { ok: false, reason: 'expired' };
  }

  await pool.query(
    `UPDATE agent_session SET last_activity_at = now() WHERE id = $1`,
    [session.id],
  );

  return {
    ok: true,
    session,
    agentAuth: { id: session.agent_id },
  };
}

export async function revokeAgentSession(token) {
  const tokenHash = hashSessionToken(token);
  await pool.query(
    `UPDATE agent_session
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE token_hash = $1`,
    [tokenHash],
  );
}

export async function revokeAllAgentSessions(agentId) {
  await pool.query(
    `UPDATE agent_session
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE agent_id = $1 AND revoked_at IS NULL`,
    [agentId],
  );
}

export async function purgeExpiredAgentSessions() {
  await pool.query(
    `UPDATE agent_session
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE revoked_at IS NULL AND expires_at <= now()`,
  );
}
