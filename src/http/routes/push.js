import { Router } from 'express';
import { requireAdminToken } from '../middleware/admin.js';
import { savePushSubscription, deactivatePushSubscription, sendToUser, sendToAll, validatePushSendPayload } from '../../services/pushNotification.service.js';

const router = Router();

router.get('/vapid-public-key', (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

router.post('/subscribe', async (req, res, next) => {
  try {
    await savePushSubscription(req.body, {
      userAgent: req.headers['user-agent'],
      deviceName: req.body.deviceName,
      userId: req.body.userId,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/unsubscribe', async (req, res, next) => {
  try {
    const endpoint = req.body?.endpoint || req.body?.subscription?.endpoint;
    await deactivatePushSubscription(endpoint);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/send', requireAdminToken, async (req, res, next) => {
  try {
    const payload = validatePushSendPayload(req.body);
    await sendToUser(req.body.userId, payload);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/send-all', requireAdminToken, async (req, res, next) => {
  try {
    const payload = validatePushSendPayload(req.body);
    await sendToAll(payload);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
