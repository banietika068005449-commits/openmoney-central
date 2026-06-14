import { pool } from '../db.js';

const CLE_SYSTEM_PROMPT = 'system_prompt';

async function get(cle) {
  const { rows } = await pool.query(
    'SELECT valeur FROM parametre WHERE cle = $1',
    [cle],
  );
  return rows[0]?.valeur ?? null;
}

async function set(cle, valeur) {
  await pool.query(
    `INSERT INTO parametre (cle, valeur)
     VALUES ($1, $2)
     ON CONFLICT (cle) DO UPDATE
       SET valeur = EXCLUDED.valeur,
           mis_a_jour_le = now()`,
    [cle, valeur],
  );
}

export const getSystemPrompt = () => get(CLE_SYSTEM_PROMPT);
export const setSystemPrompt = (v) => set(CLE_SYSTEM_PROMPT, v);
