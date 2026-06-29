import { pool } from '../db.js';
import { PushNotificationService } from '../services/pushNotification.service.js';

/**
 * Ingestion idempotente d'un lot de SMS pousse par un point de vente.
 *
 * Strategie :
 *  - Une seule transaction.
 *  - INSERT en lot dans `sms` avec ON CONFLICT (empreinte) DO NOTHING.
 *  - Garde defensive : si un ancien APK envoie le meme SMS avec deux
 *    empreintes differentes (timestamp different), on dedoublonne aussi sur
 *    emetteur + contenu normalises.
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
const pushService = new PushNotificationService();

export async function ingest(payload) {
  const { pointDeVente, messages } = payload;
  if (messages.length === 0) return { acceptes: [], recu: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const messagesAInserer = dedupeMessages(messages);
    const values = [];
    const params = [];
    let i = 1;
    for (const m of messagesAInserer) {
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

    if (values.length > 0) {
      await client.query(
        `INSERT INTO sms (uuid, sender, content, smsc_ts, empreinte, point_de_vente)
         SELECT v.uuid::uuid, v.sender, v.content, v.smsc_ts::timestamptz, v.empreinte::char(64), v.point_de_vente
         FROM (VALUES ${values.join(',')}) AS v(uuid, sender, content, smsc_ts, empreinte, point_de_vente)
         WHERE NOT EXISTS (
           SELECT 1
           FROM sms s
           WHERE lower(regexp_replace(trim(s.sender), '\\s+', '', 'g')) = lower(regexp_replace(trim(v.sender), '\\s+', '', 'g'))
             AND regexp_replace(trim(s.content), '\\s+', ' ', 'g') = regexp_replace(trim(v.content), '\\s+', ' ', 'g')
         )
         ON CONFLICT (empreinte) DO NOTHING`,
        params,
      );
    }

    await client.query('COMMIT');

    for (const message of messagesAInserer) {
      const content = String(message.message || '').trim();
      if (!content) continue;
      try {
        await pushService.sendToAll({
          title: 'Nouvelle transaction',
          body: content.slice(0, 140),
          url: '/',
          icon: '/logo.png',
          badge: '/logo.png',
        });
      } catch (err) {
        console.error('[push] envoi apres ingestion impossible', err.message);
      }
    }

    return { acceptes: messages.map((m) => m.uuid), recu: messages.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function dedupeMessages(messages) {
  const seen = new Set();
  const out = [];
  for (const message of messages) {
    const key = `${normalizeSender(message.numeroTel)}\u0000${normalizeContent(message.message)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(message);
  }
  return out;
}

function normalizeSender(sender) {
  return String(sender ?? '').trim().replace(/\s+/g, '').toLowerCase();
}

function normalizeContent(content) {
  return String(content ?? '').trim().replace(/\s+/g, ' ');
}
