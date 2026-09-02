import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import {
  listSms, getSmsById, deleteSmsById, resetForReanalyze, setSmsStatus, setSmsNote, setTransactionNote, setTecno,
} from '../../repos/sms.repo.js';
import {
  SmsExportError, writeSmsPdfExport, writeSmsPngZipExport,
} from '../../services/smsExport.service.js';

const FILTER_SCHEMA_SHAPE = {
  status:   z.string().optional(),
  smsType:  z.string().optional(),
  operator: z.string().optional(),
  operatorPrefix: z.enum(['MTN', 'AIRTEL']).optional(),
  phone:    z.string().trim().optional(),
  transactionId: z.string().trim().optional(),
  hasNote:  z.coerce.boolean().optional(),
  tecno:    z.enum(['only', 'hide']).optional(),
  amount: z.coerce.number().int().positive().optional(),
  q:        z.string().optional(),
  sort:     z.enum(['recent', 'ancient']).optional(),
  period:   z.enum(['all', 'days', 'week']).optional().default('all'),
  date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hour:     z.coerce.number().int().min(0).max(23).optional(),
};

const listSchema = z.object({
  ...FILTER_SCHEMA_SHAPE,
  limit:  z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});
const exportSchema = z.object(FILTER_SCHEMA_SHAPE);

async function handleExport(req, res, next, writer) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortIfIncomplete = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once('aborted', abort);
  res.once('close', abortIfIncomplete);

  try {
    const filters = exportSchema.parse(req.query);
    await writer({ filters, response: res, signal: controller.signal });
  } catch (error) {
    if (error?.code === 'EXPORT_ABORTED' || controller.signal.aborted) return;
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    if (error instanceof SmsExportError) {
      res.status(error.status).json({ error: error.code });
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'INVALID_EXPORT_FILTERS', details: error.flatten() });
      return;
    }
    next(error);
  } finally {
    req.off('aborted', abort);
    res.off('close', abortIfIncomplete);
  }
}

/**
 * @param {{ analysisService: import('../../analysis/service.js').SmsAnalysisService }} deps
 */
export function smsRouter({ analysisService }) {
  const router = Router();
  router.use(requireAdminToken);

  router.get('/', async (req, res, next) => {
    try {
      const f = listSchema.parse(req.query);
      const r = await listSms(f);
      res.json(r);
    } catch (e) { next(e); }
  });

  // Toujours declarer les exports avant /:id pour que "export.pdf" ne soit
  // jamais interprete comme un identifiant de SMS.
  router.get('/export.pdf', (req, res, next) => (
    handleExport(req, res, next, writeSmsPdfExport)
  ));

  router.get('/export-images.zip', (req, res, next) => (
    handleExport(req, res, next, writeSmsPngZipExport)
  ));

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

  return router;
}
