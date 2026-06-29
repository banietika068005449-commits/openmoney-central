import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import {
  listSms, getSmsById, deleteSmsById, resetForReanalyze, setSmsStatus,
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
    q:        z.string().optional(),
    sort:     z.enum(['recent', 'ancient']).optional(),
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

  return router;
}
