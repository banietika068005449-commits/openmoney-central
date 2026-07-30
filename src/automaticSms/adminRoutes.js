import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../http/middleware/admin.js';
import {
  addOptOut,
  createPartner,
  dashboardState,
  deactivatePartner,
  insertPartnerKey,
  revokePartnerKey,
  removeOptOut,
  setPartnerActive,
} from './repo.js';
import { normalizeCongoPhone } from './phone.js';

const router = Router();
router.use(requireAdminToken);

router.get('/', async (_req, res, next) => {
  try { return res.json(await dashboardState()); } catch (error) { return next(error); }
});

router.post('/partners', async (req, res, next) => {
  try {
    const parsed = z.object({
      id: z.string().regex(/^[a-z0-9_]{3,80}$/),
      name: z.string().trim().min(2).max(100),
    }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'PARTNER_INVALID', details: parsed.error.flatten() });
    }
    return res.status(201).json(await createPartner(parsed.data));
  } catch (error) { return next(error); }
});

router.delete('/partners/:partnerId', async (req, res, next) => {
  try {
    const partnerId = z.string().regex(/^[a-z0-9_]{3,80}$/).safeParse(req.params.partnerId);
    if (!partnerId.success) return res.status(400).json({ error: 'PARTNER_ID_INVALID' });
    const partner = await deactivatePartner(partnerId.data);
    if (!partner) return res.status(404).json({ error: 'PARTNER_NOT_FOUND' });
    return res.json(partner);
  } catch (error) { return next(error); }
});

router.post('/opt-outs', async (req, res, next) => {
  try {
    const parsed = z.object({
      phoneNumber: z.string().min(1).max(40),
      source: z.string().trim().min(2).max(80).default('admin'),
      reason: z.string().trim().max(200).optional(),
    }).parse(req.body);
    const phone = normalizeCongoPhone(parsed.phoneNumber);
    if (!phone) return res.status(400).json({ error: 'PHONE_INVALID' });
    return res.status(201).json(await addOptOut(phone, parsed.source, parsed.reason));
  } catch (error) { return next(error); }
});

router.delete('/opt-outs/:phoneNumber', async (req, res, next) => {
  try {
    const phone = normalizeCongoPhone(req.params.phoneNumber);
    if (!phone) return res.status(400).json({ error: 'PHONE_INVALID' });
    if (!(await removeOptOut(phone))) return res.status(404).json({ error: 'OPT_OUT_NOT_FOUND' });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

router.patch('/partners/:partnerId', async (req, res, next) => {
  try {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const partner = await setPartnerActive(req.params.partnerId, active);
    if (!partner) return res.status(404).json({ error: 'PARTNER_NOT_FOUND' });
    return res.json(partner);
  } catch (error) { return next(error); }
});

router.post('/partners/:partnerId/keys', async (req, res, next) => {
  try {
    const { label } = z.object({ label: z.string().trim().max(100).default('') }).parse(req.body);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keyId = randomUUID();
    const saved = await insertPartnerKey({
      partnerId: req.params.partnerId,
      keyId,
      label,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    });
    return res.status(201).json({
      ...saved,
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      warning: 'Cette cle privee ne sera plus jamais affichee.',
    });
  } catch (error) { return next(error); }
});

router.delete('/keys/:keyId', async (req, res, next) => {
  try {
    const revoked = await revokePartnerKey(req.params.keyId);
    if (!revoked) return res.status(404).json({ error: 'KEY_NOT_FOUND' });
    return res.json(revoked);
  } catch (error) { return next(error); }
});

export default router;
