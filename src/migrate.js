import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = resolve(here, '..', 'sql', 'init.sql');
const cleanupPath = resolve(here, '..', 'sql', 'cleanup_removed_modules.sql');

const sql = readFileSync(sqlPath, 'utf8');
const cleanupSql = readFileSync(cleanupPath, 'utf8');
await pool.query(sql);
await pool.query(cleanupSql);
const verification = await pool.query(`
  SELECT
    to_regclass('public.agent') AS agent_table,
    to_regclass('public.automatic_sms_request') AS dispatcher_table,
    to_regclass('public.client_imei') AS imei_table,
    to_regclass('public.client_badge') AS echeance_table,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sms'
        AND column_name = 'admin_processing_status'
    ) AS manual_status_column,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sms_analysis'
        AND column_name = 'imei'
    ) AS imei_column
`);
if (Object.values(verification.rows[0]).some(Boolean)) {
  throw new Error('La verification de purge des modules retires a echoue');
}
await pool.end();
console.log('[migrate] schema principal applique et modules retires purges');
