import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../http/middleware/admin.js';
import {
  assignDispatcher,
  addOptOut,
  allowPartnerTemplate,
  createDispatcher,
  createPartner,
  createTemplate,
  dashboardState,
  deactivateDispatcher,
  deactivatePartner,
  deactivateTemplate,
  insertPartnerKey,
  reactivateAndAssignDispatcher,
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

router.post('/dispatchers', async (req, res, next) => {
  try {
    const { name } = z.object({ name: z.string().trim().min(2).max(100) }).parse(req.body);
    return res.status(201).json(await createDispatcher(name));
  } catch (error) { return next(error); }
});

router.delete('/dispatchers/:dispatcherId', async (req, res, next) => {
  try {
    const dispatcherId = z.string().uuid().safeParse(req.params.dispatcherId);
    if (!dispatcherId.success) return res.status(400).json({ error: 'DISPATCHER_ID_INVALID' });
    const dispatcher = await deactivateDispatcher(dispatcherId.data);
    if (!dispatcher) return res.status(404).json({ error: 'DISPATCHER_NOT_FOUND' });
    return res.json(dispatcher);
  } catch (error) { return next(error); }
});

router.post('/dispatchers/:dispatcherId/reactivate', async (req, res, next) => {
  try {
    const dispatcherId = z.string().uuid().safeParse(req.params.dispatcherId);
    const body = z.object({
      partnerId: z.string().regex(/^[a-z0-9_]{3,80}$/),
    }).safeParse(req.body);
    if (!dispatcherId.success) return res.status(400).json({ error: 'DISPATCHER_ID_INVALID' });
    if (!body.success) return res.status(400).json({ error: 'PARTNER_ID_INVALID' });
    return res.json(await reactivateAndAssignDispatcher(dispatcherId.data, body.data.partnerId));
  } catch (error) {
    if (['PARTNER_NOT_FOUND', 'DISPATCHER_NOT_FOUND', 'DISPATCHER_NOT_ENROLLED'].includes(error.message)) {
      return res.status(error.status || 409).json({ error: error.message });
    }
    return next(error);
  }
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

router.put('/partners/:partnerId/dispatcher', async (req, res, next) => {
  try {
    const { dispatcherId } = z.object({ dispatcherId: z.string().uuid() }).parse(req.body);
    return res.json(await assignDispatcher(req.params.partnerId, dispatcherId));
  } catch (error) { return next(error); }
});

router.put('/partners/:partnerId/templates/:templateId', async (req, res, next) => {
  try {
    const allowed = await allowPartnerTemplate(req.params.partnerId, req.params.templateId);
    if (!allowed) return res.status(404).json({ error: 'PARTNER_OR_TEMPLATE_NOT_FOUND' });
    return res.json(allowed);
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

router.post('/templates', async (req, res, next) => {
  try {
    const parsed = z.object({
      id: z.string().regex(/^[a-z0-9_]{3,120}$/),
      body: z.string().min(1).max(918),
      variableSchema: z.record(z.string(), z.object({
        required: z.boolean().default(false),
        maxLength: z.number().int().min(1).max(500).default(200),
      })).default({}),
    }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'TEMPLATE_INVALID',
        details: parsed.error.flatten(),
      });
    }
    return res.status(201).json(await createTemplate(parsed.data));
  } catch (error) { return next(error); }
});

router.delete('/templates/:templateId', async (req, res, next) => {
  try {
    const templateId = z.string().regex(/^[a-z0-9_]{3,120}$/).safeParse(req.params.templateId);
    if (!templateId.success) {
      return res.status(400).json({ error: 'TEMPLATE_ID_INVALID' });
    }
    const versions = await deactivateTemplate(templateId.data);
    if (versions.length === 0) {
      return res.status(404).json({ error: 'TEMPLATE_NOT_FOUND' });
    }
    return res.json({
      id: templateId.data,
      deactivatedVersions: versions.map((item) => item.version),
    });
  } catch (error) { return next(error); }
});

export default router;
