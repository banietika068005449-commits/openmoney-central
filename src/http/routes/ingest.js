import { Router } from 'express';
import { z } from 'zod';
import { requireIngestToken } from '../middleware/auth.js';
import { ingest } from '../../ingest/service.js';

const router = Router();

const schema = z.object({
  pointDeVente: z.string().min(1).max(64),
  messages: z.array(z.object({
    uuid: z.string().uuid(),
    empreinte: z.string().length(64).regex(/^[a-f0-9]{64}$/i, 'sha256 hex attendu'),
    numeroTel: z.string().min(1).max(20),
    message: z.string().min(1).max(5000),
    smsRecuLe: z.string().datetime().nullish(),
  })).max(500),
});

router.post('/ingest', requireIngestToken, async (req, res, next) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Payload invalide',
      details: parsed.error.flatten(),
    });
  }
  try {
    const result = await ingest(parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
