import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db.js';

export function hashAccessToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function listAccessTokens() {
  const { rows } = await pool.query(`
    SELECT id, label, token_prefix, is_active, last_used_at, created_at, revoked_at
    FROM access_token
    ORDER BY created_at DESC, id DESC
  `);
  return { items: rows };
}

export async function createAccessToken(label) {
  const token = `om_live_${randomBytes(32).toString('base64url')}`;
  const tokenHash = hashAccessToken(token);
  const tokenPrefix = `${token.slice(0, 15)}...`;
  const { rows } = await pool.query(
    `INSERT INTO access_token (label, token_hash, token_prefix)
     VALUES ($1, $2, $3)
     RETURNING id, label, token_prefix, is_active, last_used_at, created_at, revoked_at`,
    [label, tokenHash, tokenPrefix],
  );
  return { ...rows[0], token };
}

export async function findActiveAccessToken(token) {
  const tokenHash = hashAccessToken(token);
  const { rows } = await pool.query(
    `SELECT id, label
     FROM access_token
     WHERE token_hash = $1 AND is_active = true
     LIMIT 1`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function markAccessTokenUsed(id) {
  await pool.query(
    `UPDATE access_token SET last_used_at = now() WHERE id = $1`,
    [id],
  );
}

export async function revokeAccessToken(id) {
  const { rows } = await pool.query(
    `UPDATE access_token
     SET is_active = false, revoked_at = now()
     WHERE id = $1 AND is_active = true
     RETURNING id`,
    [id],
  );
  return rows.length > 0;
}
