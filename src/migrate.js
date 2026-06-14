import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = resolve(here, '..', 'sql', 'init.sql');

const sql = readFileSync(sqlPath, 'utf8');
await pool.query(sql);
await pool.end();
console.log('[migrate] schema applique depuis sql/init.sql');
