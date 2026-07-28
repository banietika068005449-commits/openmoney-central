import { Router } from 'express';
import { z } from 'zod';
import { requireDispatcher } from './mobileAuth.js';
import {
  appendEvents,
  authorizeSend,
  claimNext,
  enrollDispatcher,
  markReceived,
} from './repo.js';

const router = Router();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

router.post('/dispatchers/enroll', async (req, res, next) => {
  try {
    const parsed = z.object({
      enrollmentCode: z.string().min(16).max(200),
      deviceId: z.string().min(8).max(200),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'ENROLLMENT_INVALID' });
    const enrolled = await enrollDispatcher(parsed.data.enrollmentCode, parsed.data.deviceId);
    if (!enrolled) return res.status(401).json({ error: 'ENROLLMENT_CODE_INVALID' });
    return res.json(enrolled);
  } catch (error) {
    return next(error);
  }
});

router.use(requireDispatcher);

router.post('/claims/next', async (req, res, next) => {
  const waitSeconds = Math.min(25, Math.max(0, Number(req.body?.waitSeconds ?? 25)));
  const deadline = Date.now() + waitSeconds * 1000;
  try {
    do {
      const item = await claimNext(req.dispatcher.id);
      if (item) {
        return res.json({
          id: item.id,
          partnerId: item.partner_id,
          partnerKeyId: item.partner_key_id,
          requestId: item.request_id,
          campaignId: item.campaign_id,
          normalizedPhone: item.normalized_phone,
          templateId: item.template_id,
          templateVersion: item.template_version,
          templateBody: item.template_body,
          variables: item.variables,
          renderedText: item.rendered_text,
          scheduledAt: item.scheduled_at,
          expiresAt: item.expires_at,
          rawBody: Buffer.from(item.raw_body, 'utf8').toString('base64url'),
          signature: item.signature,
          signatureTimestamp: item.signature_timestamp,
          signatureNonce: item.signature_nonce,
          partnerPublicKey: item.public_key_pem,
        });
      }
      if (Date.now() < deadline) await sleep(Math.min(500, deadline - Date.now()));
    } while (Date.now() < deadline);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

router.post('/jobs/:id/received', async (req, res, next) => {
  try {
    const item = await markReceived(req.params.id, req.dispatcher.id);
    if (!item) return res.status(404).json({ error: 'JOB_NOT_FOUND' });
    return res.json({ id: item.id, received: true });
  } catch (error) {
    return next(error);
  }
});

router.post('/jobs/:id/authorize', async (req, res, next) => {
  try {
    const auth = await authorizeSend(req.params.id, req.dispatcher.id);
    if (!auth) return res.status(403).json({ error: 'JOB_NOT_AUTHORIZED' });
    return res.json({ authorizationUntil: auth.authorization_until });
  } catch (error) {
    return next(error);
  }
});

router.post('/events', async (req, res, next) => {
  try {
    const parsed = z.object({
      events: z.array(z.object({
        eventId: z.string().min(8).max(200),
        requestId: z.string().uuid(),
        status: z.enum([
          'WAITING_ADVANCED_MODE', 'PENDING', 'PROCESSING', 'SENT', 'DELIVERED',
          'FAILED_RETRYABLE', 'FAILED_FINAL', 'BLOCKED',
        ]),
        reason: z.string().max(200).nullable().optional(),
        details: z.record(z.string(), z.unknown()).optional(),
        occurredAt: z.string().datetime({ offset: true }),
      })).min(1).max(100),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'EVENTS_INVALID' });
    const accepted = await appendEvents(req.dispatcher.id, parsed.data.events);
    return res.json({ accepted });
  } catch (error) {
    return next(error);
  }
});

export default router;
