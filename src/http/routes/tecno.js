import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import {
  listForcedTecno, addForcedTecno, removeForcedTecno,
} from '../../repos/sms.repo.js';

const router = Router();
router.use(requireAdminToken);

const createSchema = z.object({
  phone: z.string().trim().min(1).max(32),
});

router.get('/', async (_req, res, next) => {
  try { res.json(await listForcedTecno()); } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { phone } = createSchema.parse(req.body);
    const created = await addForcedTecno(phone);
    if (!created) return res.status(400).json({ error: 'Numero invalide' });
    res.status(201).json(created);
  } catch (e) { next(e); }
});

router.delete('/:phone', async (req, res, next) => {
  try {
    const ok = await removeForcedTecno(req.params.phone);
    if (!ok) return res.status(404).json({ error: 'Numero introuvable' });
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
