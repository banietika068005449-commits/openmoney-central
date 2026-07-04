import webPush from 'web-push';
import { pool } from '../db.js';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contact@open-money.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function normalizePayload(payload = {}) {
  return {
    title: payload.title || 'OpenMoney',
    body: payload.body || '',
    icon: payload.icon || '/logo.png',
    badge: payload.badge || '/logo.png',
    url: payload.url || '/',
    tag: payload.tag || 'openmoney-new-transaction',
    data: payload.data || {},
  };
}

function normalizeSubscription(row) {
  if (!row) return null;
  return {
    endpoint: row.endpoint,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth,
    },
  };
}

export class PushNotificationService {
  async subscribeSubscription(subscription, meta = {}) {
    const endpoint = subscription?.endpoint;
    if (!endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      throw new Error('Abonnement push invalide');
    }

    const { rows } = await pool.query(
      `INSERT INTO push_subscription (
        endpoint, p256dh, auth, user_agent, device_name, is_active, created_at, updated_at, last_used_at
      ) VALUES ($1,$2,$3,$4,$5,true,NOW(),NOW(),NOW())
      ON CONFLICT (endpoint) DO UPDATE SET
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = COALESCE(EXCLUDED.user_agent, push_subscription.user_agent),
        device_name = COALESCE(EXCLUDED.device_name, push_subscription.device_name),
        is_active = true,
        updated_at = NOW(),
        last_used_at = NOW()
      RETURNING id, endpoint, p256dh, auth, user_agent, device_name, is_active, created_at, updated_at, last_used_at`,
      [endpoint, subscription.keys.p256dh, subscription.keys.auth, meta.userAgent || null, meta.deviceName || null],
    );

    return rows[0];
  }

  async unsubscribeSubscription(endpoint) {
    const { rowCount } = await pool.query(
      `UPDATE push_subscription SET is_active = false, updated_at = NOW() WHERE endpoint = $1`,
      [endpoint],
    );
    return rowCount > 0;
  }

  async sendToSubscription(subscription, payload = {}) {
    const normalized = normalizePayload(payload);
    try {
      await webPush.sendNotification(subscription, JSON.stringify(normalized));
      await pool.query(`UPDATE push_subscription SET last_used_at = NOW() WHERE endpoint = $1`, [subscription.endpoint]);
      return { ok: true };
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await this.removeInvalidSubscription(subscription.endpoint);
      }
      return { ok: false, error: err.message, statusCode: err.statusCode };
    }
  }

  async sendToUser(userId, payload = {}) {
    const { rows } = await pool.query(
      `SELECT endpoint, p256dh, auth FROM push_subscription WHERE is_active = true AND user_id = $1`,
      [userId],
    );
    const results = [];
    for (const row of rows) {
      results.push(await this.sendToSubscription(normalizeSubscription(row), payload));
    }
    return results;
  }

  async sendToAll(payload = {}) {
    const { rows } = await pool.query(
      `SELECT endpoint, p256dh, auth FROM push_subscription WHERE is_active = true`,
    );
    const results = [];
    for (const row of rows) {
      results.push(await this.sendToSubscription(normalizeSubscription(row), payload));
    }
    return results;
  }

  async removeInvalidSubscription(endpoint) {
    await pool.query(`UPDATE push_subscription SET is_active = false, updated_at = NOW() WHERE endpoint = $1`, [endpoint]);
  }
}
