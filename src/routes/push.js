import express from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { PushNotificationService } from '../services/pushNotification.service.js';

const router = express.Router();
const pushService = new PushNotificationService();

const subscribeSchema = z.object({
  endpoint: z.string().url().min(1),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userId: z.string().nullable().optional(),
  deviceName: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url().min(1),
});

const sendSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  url: z.string().optional(),
  icon: z.string().optional(),
  badge: z.string().optional(),
  userId: z.string().nullable().optional(),
});

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Non autorise' });
  }
  next();
}

router.post('/subscribe', async (req, res) => {
  try {
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Payload invalide', issues: parsed.error.issues });
    }

    const subscription = await pushService.subscribeSubscription(parsed.data, {
      userAgent: parsed.data.userAgent || req.get('user-agent') || null,
      deviceName: parsed.data.deviceName || null,
    });

    res.json({ ok: true, subscription });
  } catch (err) {
    console.error('[push] subscribe error', err);
    res.status(500).json({ error: err.message || 'Erreur inscription push' });
  }
});

router.post('/unsubscribe', async (req, res) => {
  try {
    const parsed = unsubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Payload invalide' });
    }
    const removed = await pushService.unsubscribeSubscription(parsed.data.endpoint);
    res.json({ ok: true, removed });
  } catch (err) {
    console.error('[push] unsubscribe error', err);
    res.status(500).json({ error: err.message || 'Erreur desinscription push' });
  }
});

router.post('/send', requireAdmin, async (req, res) => {
  try {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Payload invalide' });
    }
    const results = parsed.data.userId
      ? await pushService.sendToUser(parsed.data.userId, parsed.data)
      : [];
    res.json({ ok: true, results });
  } catch (err) {
    console.error('[push] send error', err);
    res.status(500).json({ error: err.message || 'Erreur envoi push' });
  }
});

router.post('/send-all', requireAdmin, async (req, res) => {
  try {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Payload invalide' });
    }
    const results = await pushService.sendToAll(parsed.data);
    res.json({ ok: true, results });
  } catch (err) {
    console.error('[push] send-all error', err);
    res.status(500).json({ error: err.message || 'Erreur envoi global push' });
  }
});

export default router;
