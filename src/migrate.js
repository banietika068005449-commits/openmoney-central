import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from './db.js';
import { ensureAgentSchema } from './repos/agentSchema.repo.js';
import { ensureAutomaticSmsSchema } from './automaticSms/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = resolve(here, '..', 'sql', 'init.sql');

const sql = readFileSync(sqlPath, 'utf8');
await pool.query(sql);
await ensureAgentSchema();
await ensureAutomaticSmsSchema();
await pool.end();
console.log('[migrate] schemas principal, agent et automatic-sms appliques');
