import { pool } from '../db.js';

// ---- Providers ----

const PROVIDER_COUNTS = `,
  COALESCE((SELECT COUNT(*) FROM ai_provider_key k WHERE k.provider_id = p.id), 0)::int AS keys_total,
  COALESCE((SELECT COUNT(*) FROM ai_provider_key k WHERE k.provider_id = p.id AND k.is_active), 0)::int AS keys_active
`;

export async function listProviders() {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.provider_type, p.model, p.base_url, p.is_active, p.created_at
     ${PROVIDER_COUNTS}
     FROM ai_provider p
     ORDER BY p.id DESC`,
  );
  return { items: rows };
}

export async function getProviderById(id) {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.provider_type, p.model, p.base_url, p.is_active, p.created_at
     ${PROVIDER_COUNTS}
     FROM ai_provider p WHERE p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Si `name` n'est pas fourni, on derive un libelle stable a partir du
 * type et du modele. Le UI n'expose plus de champ Nom.
 */
function autoName({ name, providerType, model }) {
  if (name && name.trim()) return name.trim();
  return `${providerType}/${model}`;
}

export async function createProvider({ name, providerType, model, baseUrl }) {
  const finalName = autoName({ name, providerType, model });
  const { rows } = await pool.query(
    `INSERT INTO ai_provider (name, provider_type, model, base_url)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [finalName, providerType, model, baseUrl ?? null],
  );
  return getProviderById(rows[0].id);
}

export async function updateProvider(id, patch) {
  const sets = [];
  const params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (patch.name        !== undefined) add('name', patch.name);
  if (patch.providerType!== undefined) add('provider_type', patch.providerType);
  if (patch.model       !== undefined) add('model', patch.model);
  if (patch.baseUrl     !== undefined) add('base_url', patch.baseUrl);
  if (patch.isActive    !== undefined) add('is_active', patch.isActive);
  if (sets.length === 0) return getProviderById(id);

  sets.push(`updated_at = NOW()`);
  params.push(id);
  await pool.query(
    `UPDATE ai_provider SET ${sets.join(', ')} WHERE id = $${params.length}`,
    params,
  );
  return getProviderById(id);
}

export async function deleteProvider(id) {
  const { rowCount } = await pool.query(`DELETE FROM ai_provider WHERE id = $1`, [id]);
  return rowCount > 0;
}

// ---- Keys ----

export async function listKeys(providerId) {
  const { rows } = await pool.query(
    `SELECT id, provider_id, label, api_key, is_active, last_used_at, usage_count, created_at
     FROM ai_provider_key
     WHERE provider_id = $1
     ORDER BY id DESC`,
    [providerId],
  );
  return { items: rows };
}

export async function createKey(providerId, { label, apiKey }) {
  const { rows } = await pool.query(
    `INSERT INTO ai_provider_key (provider_id, label, api_key)
     VALUES ($1, $2, $3)
     RETURNING id, provider_id, label, api_key, is_active, last_used_at, usage_count, created_at`,
    [providerId, label ?? null, apiKey],
  );
  return rows[0];
}

export async function updateKey(id, patch) {
  const sets = [];
  const params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (patch.label    !== undefined) add('label', patch.label);
  if (patch.apiKey   !== undefined) add('api_key', patch.apiKey);
  if (patch.isActive !== undefined) add('is_active', patch.isActive);
  if (sets.length === 0) {
    const { rows } = await pool.query(`SELECT * FROM ai_provider_key WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }
  params.push(id);
  const { rows } = await pool.query(
    `UPDATE ai_provider_key SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, provider_id, label, api_key, is_active, last_used_at, usage_count, created_at`,
    params,
  );
  return rows[0] ?? null;
}

export async function deleteKey(id) {
  const { rowCount } = await pool.query(`DELETE FROM ai_provider_key WHERE id = $1`, [id]);
  return rowCount > 0;
}
