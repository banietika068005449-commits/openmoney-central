import { pool } from '../db.js';
import { PushNotificationService } from '../services/pushNotification.service.js';
import { dedupeMessages } from './identity.js';

/**
 * Ingestion idempotente d'un lot de SMS pousse par un point de vente.
 *
 * Strategie :
 *  - Une seule transaction.
 *  - INSERT en lot dans `sms` avec ON CONFLICT (empreinte) DO NOTHING.
 *  - Garde defensive par identite source exacte : emetteur + contenu
 *    normalises + horodatage SMS. Deux transactions identiques recues a des
 *    instants differents restent donc deux transactions.
 *    Les lignes inserees prennent status='received', le worker les
 *    detecte au prochain tick et lance l'analyse.
 *  - RETURNING identifie les seules lignes nouvellement inserees afin de ne
 *    notifier qu'une fois ; les UUID du lot restent acquittes de facon
 *    idempotente, qu'ils soient nouveaux ou deja presents.
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

    let insertedMessages = [];
    if (values.length > 0) {
      const inserted = await client.query(
        `INSERT INTO sms (uuid, sender, content, smsc_ts, empreinte, point_de_vente)
         SELECT v.uuid::uuid, v.sender, v.content, v.smsc_ts::timestamptz, v.empreinte::char(64), v.point_de_vente
         FROM (VALUES ${values.join(',')}) AS v(uuid, sender, content, smsc_ts, empreinte, point_de_vente)
         WHERE NOT EXISTS (
           SELECT 1
           FROM sms s
           WHERE lower(regexp_replace(trim(s.sender), '\\s+', '', 'g')) = lower(regexp_replace(trim(v.sender), '\\s+', '', 'g'))
             AND regexp_replace(trim(s.content), '\\s+', ' ', 'g') = regexp_replace(trim(v.content), '\\s+', ' ', 'g')
             AND s.smsc_ts IS NOT DISTINCT FROM v.smsc_ts::timestamptz
         )
         ON CONFLICT (empreinte) DO NOTHING
         RETURNING uuid, content`,
        params,
      );
      insertedMessages = inserted.rows;
    }

    await client.query('COMMIT');

    for (const message of insertedMessages) {
      const content = String(message.content || '').trim();
      if (!content) continue;
      try {
        await pushService.sendToAll({
          title: 'Nouvelle transaction',
          body: content.slice(0, 140),
          url: '/',
          icon: '/logo.png',
          badge: '/logo.png',
          tag: 'openmoney-new-transaction',
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
