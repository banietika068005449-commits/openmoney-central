import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import {
  listSms, getSmsById, deleteSmsById, resetForReanalyze, setSmsStatus, setSmsImei, setSmsNote, setSmsEcheance, setTransactionNote, setTransactionBadge, setManualDate, setTecno,
} from '../../repos/sms.repo.js';

/**
 * @param {{ analysisService: import('../../analysis/service.js').SmsAnalysisService }} deps
 */
export function smsRouter({ analysisService }) {
  const router = Router();
  router.use(requireAdminToken);

  const listSchema = z.object({
    limit:    z.coerce.number().int().positive().max(500).default(50),
    offset:   z.coerce.number().int().nonnegative().default(0),
    status:   z.string().optional(),
    smsType:  z.string().optional(),
    operator: z.string().optional(),
    operatorPrefix: z.enum(['MTN', 'AIRTEL']).optional(),
    phone:    z.string().trim().optional(),
    transactionId: z.string().trim().optional(),
    imei:     z.string().trim().regex(/^\d{0,32}$/).optional(),
    hasImei:  z.coerce.boolean().optional(),
    hasNote:  z.coerce.boolean().optional(),
    tecno:    z.enum(['only', 'hide']).optional(),
    amount: z.coerce.number().int().positive().optional(),
    amountRule: z.coerce.number().int().positive().optional(),
    q:        z.string().optional(),
    sort:     z.enum(['recent', 'ancient']).optional(),
    period:   z.enum(['all', 'days', 'week']).optional().default('all'),
    date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    hour:     z.coerce.number().int().min(0).max(23).optional(),
  });

  router.get('/', async (req, res, next) => {
    try {
      const f = listSchema.parse(req.query);
      const r = await listSms(f);
      res.json(r);
    } catch (e) { next(e); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const sms = await getSmsById(req.params.id);
      if (!sms) return res.status(404).json({ error: 'SMS introuvable' });
      res.json(sms);
    } catch (e) { next(e); }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const ok = await deleteSmsById(req.params.id);
      if (!ok) return res.status(404).json({ error: 'SMS introuvable' });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  router.post('/:id/reanalyze', async (req, res, next) => {
    try {
      const exists = await resetForReanalyze(req.params.id);
      if (!exists) return res.status(404).json({ error: 'SMS introuvable' });
      const result = await analysisService.analyzeOne(req.params.id);
      const updated = await getSmsById(req.params.id);
      res.json({ result, sms: updated });
    } catch (e) { next(e); }
  });

  router.post('/:id/copied', async (req, res, next) => {
    try {
      const updated = await setSmsStatus(req.params.id, 'treated');
      if (!updated) return res.status(404).json({ error: 'SMS introuvable' });
      res.json(updated);
    } catch (e) { next(e); }
  });

  router.patch('/:id/imei', async (req, res, next) => {
    try {
      const body = z.object({
        imei: z.string().trim().regex(/^\d{0,32}$/),
      }).parse(req.body);
      const updated = await setSmsImei(req.params.id, body.imei);
      if (!updated) return res.status(404).json({ error: 'SMS introuvable' });
      res.json(updated);
    } catch (e) { next(e); }
  });

  router.patch('/:id/note', async (req, res, next) => {
    try {
      const body = z.object({
        note: z.string().max(5000).default(''),
      }).parse(req.body);
      const updated = await setSmsNote(req.params.id, body.note);
      if (!updated) return res.status(404).json({ error: 'SMS introuvable' });
      res.json(updated);
    } catch (e) { next(e); }
  });

  router.patch('/:id/echeance', async (req, res, next) => {
    try {
      const body = z.object({
        amountRuleId: z.string().trim().max(160).default(''),
      }).parse(req.body);
      const updated = await setSmsEcheance(req.params.id, body.amountRuleId);
      if (!updated) return res.status(404).json({ error: 'Client introuvable pour ce SMS' });
      res.json(updated);
    } catch (e) { next(e); }
  });

  router.patch('/:id/transaction-date', async (req, res, next) => {
    try {
      const body = z.object({
        date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal('')]).default(''),
      }).parse(req.body);
      const updated = await setManualDate(req.params.id, body.date);
      if (!updated) return res.status(404).json({ error: 'Client introuvable pour ce SMS' });
      res.json(updated);
    } catch (e) { next(e); }
  });

  router.patch('/:id/tecno', async (req, res, next) => {
    try {
      const body = z.object({
        marked: z.coerce.boolean().default(false),
      }).parse(req.body);
      const updated = await setTecno(req.params.id, body.marked);
      if (!updated) return res.status(404).json({ error: 'Client introuvable pour ce SMS' });
      res.json(updated);
    } catch (e) { next(e); }
  });

  router.patch('/transaction-note/:transactionId', async (req, res, next) => {
    try {
      const params = z.object({
        transactionId: z.string().trim().min(1).max(160),
      }).parse(req.params);
      const body = z.object({
        note: z.string().max(5000).default(''),
      }).parse(req.body);
      const updated = await setTransactionNote(params.transactionId, body.note);
      if (!updated) return res.status(404).json({ error: 'Transaction introuvable' });
      res.json(updated);
    } catch (e) { next(e); }
  });

  router.patch('/transaction-badge/:transactionId', async (req, res, next) => {
    try {
      const params = z.object({
        transactionId: z.string().trim().min(1).max(160),
      }).parse(req.params);
      const body = z.object({
        amountRuleId: z.string().trim().max(160).default(''),
      }).parse(req.body);
      const updated = await setTransactionBadge(params.transactionId, body.amountRuleId);
      if (!updated) return res.status(404).json({ error: 'Transaction introuvable' });
      res.json(updated);
    } catch (e) { next(e); }
  });

  return router;
}
