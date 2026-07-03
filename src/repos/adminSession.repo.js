import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db.js';

export function getAdminSessionTtlMs() {
  const hours = Number(process.env.ADMIN_SESSION_TTL_HOURS || 24);
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
  return safeHours * 60 * 60 * 1000;
}

export function hashSessionToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function createAdminSession(adminAuth) {
  const token = `om_sess_${randomBytes(32).toString('base64url')}`;
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + getAdminSessionTtlMs());
  const { rows } = await pool.query(
    `INSERT INTO admin_session
       (token_hash, admin_type, access_token_id, access_token_label, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, admin_type, access_token_id, access_token_label,
               created_at, last_activity_at, expires_at`,
    [
      tokenHash,
      adminAuth.type,
      adminAuth.type === 'access_token' ? adminAuth.id : null,
      adminAuth.type === 'access_token' ? adminAuth.label : null,
      expiresAt,
    ],
  );
  return { token, session: rows[0] };
}

export async function consumeAdminSession(token) {
  const tokenHash = hashSessionToken(token);
  const { rows } = await pool.query(
    `SELECT id, admin_type, access_token_id, access_token_label,
            created_at, last_activity_at, expires_at, revoked_at
     FROM admin_session
     WHERE token_hash = $1
     LIMIT 1`,
    [tokenHash],
  );

  const session = rows[0];
  if (!session || session.revoked_at) return { ok: false, reason: 'invalid' };

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await revokeAdminSession(token);
    return { ok: false, reason: 'expired' };
  }

  await pool.query(
    `UPDATE admin_session SET last_activity_at = now() WHERE id = $1`,
    [session.id],
  );

  return {
    ok: true,
    session,
    adminAuth: {
      type: session.admin_type,
      id: session.access_token_id,
      label: session.access_token_label,
    },
  };
}

export async function revokeAdminSession(token) {
  const tokenHash = hashSessionToken(token);
  await pool.query(
    `UPDATE admin_session
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE token_hash = $1`,
    [tokenHash],
  );
}

export async function purgeExpiredAdminSessions() {
  await pool.query(
    `UPDATE admin_session
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE revoked_at IS NULL AND expires_at <= now()`,
  );
}
