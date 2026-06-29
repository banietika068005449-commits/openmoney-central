import webpush from 'web-push';
import { pool } from '../db.js';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contact@mon-domaine.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function normalizePayload(payload) {
  return {
    title: payload.title || 'OpenMoney',
    body: payload.body || '',
    icon: payload.icon || '/logo.png',
    badge: payload.badge || '/logo.png',
    url: payload.url || '/',
    data: payload.data || {},
  };
}

function buildNotificationPayload(payload) {
  const normalized = normalizePayload(payload);
  return {
    title: normalized.title,
    body: normalized.body,
    icon: normalized.icon,
    badge: normalized.badge,
    data: {
      ...normalized.data,
      url: normalized.url,
    },
  };
}

export function validatePushSubscriptionPayload(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('Payload invalide');
  }
  if (!body.endpoint || typeof body.endpoint !== 'string') {
    throw new Error('endpoint obligatoire');
  }
  if (!body.keys || typeof body.keys !== 'object') {
    throw new Error('keys obligatoire');
  }
  if (!body.keys.p256dh || typeof body.keys.p256dh !== 'string') {
    throw new Error('keys.p256dh obligatoire');
  }
  if (!body.keys.auth || typeof body.keys.auth !== 'string') {
    throw new Error('keys.auth obligatoire');
  }
  return body;
}

export function validatePushSendPayload(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('Payload invalide');
  }
  if (!body.title || typeof body.title !== 'string') {
    throw new Error('title obligatoire');
  }
  if (!body.body || typeof body.body !== 'string') {
    throw new Error('body obligatoire');
  }
  return {
    title: body.title,
    body: body.body,
    url: typeof body.url === 'string' ? body.url : '/',
    icon: typeof body.icon === 'string' ? body.icon : '/logo.png',
    badge: typeof body.badge === 'string' ? body.badge : '/logo.png',
    data: typeof body.data === 'object' && body.data ? body.data : {},
  };
}

export async function savePushSubscription(subscription, extra = {}) {
  const payload = validatePushSubscriptionPayload(subscription);
  const endpoint = payload.endpoint;
  const values = [
    endpoint,
    payload.keys.p256dh,
    payload.keys.auth,
    extra.userAgent || null,
    extra.deviceName || null,
    extra.userId || null,
    true,
  ];

  await pool.query(
    `INSERT INTO push_subscription (
      endpoint, p256dh, auth, user_agent, device_name, user_id, is_active, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
    ON CONFLICT (endpoint) DO UPDATE SET
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      user_agent = COALESCE(EXCLUDED.user_agent, push_subscription.user_agent),
      device_name = COALESCE(EXCLUDED.device_name, push_subscription.device_name),
      user_id = COALESCE(EXCLUDED.user_id, push_subscription.user_id),
      is_active = true,
      updated_at = NOW()`,
    values,
  );
}

export async function deactivatePushSubscription(endpoint) {
  if (!endpoint) return;
  await pool.query(`UPDATE push_subscription SET is_active = false, updated_at = NOW() WHERE endpoint = $1`, [endpoint]);
}

export async function listActivePushSubscriptions(userId) {
  const { rows } = await pool.query(
    `SELECT endpoint, p256dh, auth, user_agent, device_name FROM push_subscription
     WHERE is_active = true AND ($1::bigint IS NULL OR user_id = $1)`,
    [userId ?? null],
  );
  return rows;
}

export async function sendToSubscription(subscription, payload) {
  const notification = buildNotificationPayload(payload);
  const options = {
    TTL: 60,
    vapidDetails: webpush.getVapidDetails ? webpush.getVapidDetails() : undefined,
  };
  await webpush.sendNotification(
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    JSON.stringify(notification),
    options,
  );
}

export async function sendToUser(userId, payload) {
  const subscriptions = await listActivePushSubscriptions(userId);
  const notification = buildNotificationPayload(payload);
  const tasks = subscriptions.map((subscription) => sendToSubscription(subscription, notification).catch(async (err) => {
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      await deactivatePushSubscription(subscription.endpoint);
    }
  }));
  await Promise.allSettled(tasks);
}

export async function sendToAll(payload) {
  const subscriptions = await listActivePushSubscriptions();
  const notification = buildNotificationPayload(payload);
  const tasks = subscriptions.map((subscription) => sendToSubscription(subscription, notification).catch(async (err) => {
    if (err?.statusCode === 404 || err?.statusCode === 410) {
      await deactivatePushSubscription(subscription.endpoint);
    }
  }));
  await Promise.allSettled(tasks);
}
