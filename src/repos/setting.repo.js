import { pool } from '../db.js';

const CLE_SYSTEM_PROMPT = 'system_prompt';
const CLE_RECAPTCHA_ENABLED = 'recaptcha_enabled';
const CLE_RECAPTCHA_SITE_KEY = 'recaptcha_site_key';
const CLE_RECAPTCHA_SECRET_KEY = 'recaptcha_secret_key';
const CLE_IMPROVEMENT_AMOUNT_RULES = 'improvement_amount_rules';

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

async function getMany(keys) {
  const { rows } = await pool.query(
    'SELECT cle, valeur FROM parametre WHERE cle = ANY($1)',
    [keys],
  );
  return Object.fromEntries(rows.map((row) => [row.cle, row.valeur]));
}

export const getSystemPrompt = () => get(CLE_SYSTEM_PROMPT);
export const setSystemPrompt = (v) => set(CLE_SYSTEM_PROMPT, v);

export async function getRecaptchaSettings() {
  const values = await getMany([
    CLE_RECAPTCHA_ENABLED,
    CLE_RECAPTCHA_SITE_KEY,
    CLE_RECAPTCHA_SECRET_KEY,
  ]);

  return {
    enabled: values[CLE_RECAPTCHA_ENABLED] == null ? null : values[CLE_RECAPTCHA_ENABLED] === 'true',
    siteKey: values[CLE_RECAPTCHA_SITE_KEY] ?? null,
    secretKey: values[CLE_RECAPTCHA_SECRET_KEY] ?? null,
  };
}

export async function setRecaptchaSettings({ enabled, siteKey, secretKey, updateSecret = false }) {
  await set(CLE_RECAPTCHA_ENABLED, enabled ? 'true' : 'false');
  await set(CLE_RECAPTCHA_SITE_KEY, siteKey?.trim() || null);
  if (updateSecret) {
    await set(CLE_RECAPTCHA_SECRET_KEY, secretKey?.trim() || null);
  }
}

export async function getImprovementSettings() {
  const raw = await get(CLE_IMPROVEMENT_AMOUNT_RULES);
  if (!raw) return { amountRules: [] };

  try {
    const parsed = JSON.parse(raw);
    return {
      amountRules: Array.isArray(parsed?.amountRules) ? parsed.amountRules : [],
    };
  } catch {
    return { amountRules: [] };
  }
}

export async function setImprovementSettings({ amountRules = [] }) {
  await set(CLE_IMPROVEMENT_AMOUNT_RULES, JSON.stringify({ amountRules }));
}
