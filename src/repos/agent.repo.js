import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from '../db.js';
import { revokeAllAgentSessions } from './agentSession.repo.js';

// PBKDF2 identique en esprit au PinManager Android (PBKDF2WithHmacSHA256).
const PIN_ITERATIONS = 120_000;
const PIN_KEYLEN = 32; // 256 bits
const PIN_DIGEST = 'sha256';

const PUBLIC_COLUMNS = `
  id, name, city, phone, must_set_pin, is_active,
  created_at, updated_at, last_login_at
`;

function hashPin(pin, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return pbkdf2Sync(String(pin), salt, PIN_ITERATIONS, PIN_KEYLEN, PIN_DIGEST).toString('hex');
}

/** Verifie un PIN clair contre le hash/sel stockes (comparaison a temps constant). */
export function verifyAgentPin(agent, pin) {
  if (!agent?.pin_hash || !agent?.pin_salt) return false;
  const computed = Buffer.from(hashPin(pin, agent.pin_salt), 'hex');
  const expected = Buffer.from(agent.pin_hash, 'hex');
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

export async function createAgent({ name, city, phone }) {
  const { rows } = await pool.query(
    `INSERT INTO agent (name, city, phone)
     VALUES ($1, $2, $3)
     RETURNING ${PUBLIC_COLUMNS}`,
    [String(name).trim(), String(city).trim(), String(phone).trim()],
  );
  return rows[0];
}

export async function listAgents() {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM agent ORDER BY created_at DESC`,
  );
  return rows;
}

/** Ligne complete (avec pin_hash/pin_salt) pour l'authentification uniquement. */
export async function getAgentByPhone(phone) {
  const { rows } = await pool.query(
    `SELECT id, name, city, phone, pin_hash, pin_salt, must_set_pin, is_active,
            created_at, updated_at, last_login_at
     FROM agent WHERE phone = $1 LIMIT 1`,
    [String(phone).trim()],
  );
  return rows[0] ?? null;
}

export async function getAgentById(id) {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM agent WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Definit le PIN d'un agent (1ere connexion). Met must_set_pin=false. */
export async function setAgentPin(agentId, pin) {
  const saltHex = randomBytes(16).toString('hex');
  const hash = hashPin(pin, saltHex);
  const { rows } = await pool.query(
    `UPDATE agent
     SET pin_hash = $1, pin_salt = $2, must_set_pin = false, updated_at = now()
     WHERE id = $3
     RETURNING ${PUBLIC_COLUMNS}`,
    [hash, saltHex, agentId],
  );
  return rows[0] ?? null;
}

/** Reinitialise le PIN (admin) : efface hash/sel, force la redefinition, revoque les sessions. */
export async function resetAgentPin(agentId) {
  const { rows } = await pool.query(
    `UPDATE agent
     SET pin_hash = NULL, pin_salt = NULL, must_set_pin = true, updated_at = now()
     WHERE id = $1
     RETURNING ${PUBLIC_COLUMNS}`,
    [agentId],
  );
  if (!rows[0]) return null;
  await revokeAllAgentSessions(agentId);
  return rows[0];
}

export async function setAgentActive(agentId, isActive) {
  const { rows } = await pool.query(
    `UPDATE agent SET is_active = $1, updated_at = now() WHERE id = $2
     RETURNING ${PUBLIC_COLUMNS}`,
    [!!isActive, agentId],
  );
  if (rows[0] && !isActive) await revokeAllAgentSessions(agentId);
  return rows[0] ?? null;
}

export async function updateAgent(agentId, { name, city, phone }) {
  const { rows } = await pool.query(
    `UPDATE agent
     SET name = COALESCE($1, name),
         city = COALESCE($2, city),
         phone = COALESCE($3, phone),
         updated_at = now()
     WHERE id = $4
     RETURNING ${PUBLIC_COLUMNS}`,
    [
      name != null ? String(name).trim() : null,
      city != null ? String(city).trim() : null,
      phone != null ? String(phone).trim() : null,
      agentId,
    ],
  );
  return rows[0] ?? null;
}

export async function deleteAgent(agentId) {
  const { rowCount } = await pool.query(`DELETE FROM agent WHERE id = $1`, [agentId]);
  return rowCount > 0;
}

export async function touchLastLogin(agentId) {
  await pool.query(`UPDATE agent SET last_login_at = now() WHERE id = $1`, [agentId]);
}
