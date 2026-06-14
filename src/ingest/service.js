import { pool } from '../db.js';

/**
 * Ingestion idempotente d'un lot de SMS pousse par un point de vente.
 *
 * Strategie :
 *  - Une seule transaction.
 *  - INSERT en lot dans `sms` avec ON CONFLICT (empreinte) DO NOTHING.
 *    Les lignes inserees prennent status='received', le worker les
 *    detecte au prochain tick et lance l'analyse.
 *  - SELECT des empreintes presentes -> on en deduit les uuids du lot
 *    qui sont durablement persistes (nouveaux + deja existants).
 *
 * On retourne uniquement les uuids emis par CE PDV pour ce lot, ce qui
 * permet au PDV de marquer ses lignes locales comme SYNCHRONISE.
 *
 * @param {{ pointDeVente: string, messages: Array<{
 *   uuid: string, empreinte: string, numeroTel: string,
 *   message: string, smsRecuLe?: string|null
 * }>}} payload
 * @returns {Promise<{ acceptes: string[], recu: number }>}
 */
export async function ingest(payload) {
  const { pointDeVente, messages } = payload;
  if (messages.length === 0) return { acceptes: [], recu: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const values = [];
    const params = [];
    let i = 1;
    for (const m of messages) {
      values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      params.push(
        m.uuid,
        m.numeroTel,
        m.message,
        m.smsRecuLe || null,
        m.empreinte,
        pointDeVente,
      );
    }
    await client.query(
      `INSERT INTO sms (uuid, sender, content, smsc_ts, empreinte, point_de_vente)
       VALUES ${values.join(',')}
       ON CONFLICT (empreinte) DO NOTHING`,
      params,
    );

    const empreintes = messages.map((m) => m.empreinte);
    const { rows } = await client.query(
      `SELECT empreinte FROM sms WHERE empreinte = ANY($1::char(64)[])`,
      [empreintes],
    );
    const presents = new Set(rows.map((r) => r.empreinte));
    const acceptes = messages
      .filter((m) => presents.has(m.empreinte))
      .map((m) => m.uuid);

    await client.query('COMMIT');
    return { acceptes, recu: messages.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
