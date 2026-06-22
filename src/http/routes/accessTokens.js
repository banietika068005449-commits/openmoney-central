import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import {
  createAccessToken, listAccessTokens, revokeAccessToken,
} from '../../repos/accessToken.repo.js';

const router = Router();
router.use(requireAdminToken);

const createSchema = z.object({
  label: z.string().trim().min(1).max(120),
});

router.get('/', async (_req, res, next) => {
  try { res.json(await listAccessTokens()); } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { label } = createSchema.parse(req.body);
    res.status(201).json(await createAccessToken(label));
  } catch (e) { next(e); }
});

// La suppression logique permet de conserver la trace du libelle et de la date
// de revocation sans jamais pouvoir reutiliser le jeton.
router.delete('/:id', async (req, res, next) => {
  try {
    const ok = await revokeAccessToken(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Jeton actif introuvable' });
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
