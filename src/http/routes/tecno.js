import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import {
  listForcedTecno, addForcedTecno, removeForcedTecno, countForcedTecnoBySource,
} from '../../repos/sms.repo.js';
import { getTecnoSyncState } from '../../repos/setting.repo.js';
import { syncTecnoNumbers } from '../../services/tecnoSync.service.js';
import { TecnoPartnerError } from '../../services/tecnoPartner.client.js';

const router = Router();
router.use(requireAdminToken);

const createSchema = z.object({
  phone: z.string().trim().min(1).max(32),
});

router.get('/', async (_req, res, next) => {
  try { res.json(await listForcedTecno()); } catch (e) { next(e); }
});

// Statut de la synchronisation partenaire + comptage par origine.
router.get('/sync-status', async (_req, res, next) => {
  try {
    const [state, counts] = await Promise.all([getTecnoSyncState(), countForcedTecnoBySource()]);
    res.json({ ...state, counts });
  } catch (e) { next(e); }
});

// Declenchement manuel d'une synchro (mode=incremental par defaut, ?mode=full).
router.post('/sync', async (req, res, next) => {
  const mode = req.query.mode === 'full' ? 'full' : 'incremental';
  try {
    const result = await syncTecnoNumbers({ mode });
    res.json(result);
  } catch (e) {
    if (e instanceof TecnoPartnerError) {
      const status = e.code === 'SYNC_IN_PROGRESS' ? 409
        : e.code === 'NO_API_KEY' ? 503
        : 502;
      return res.status(status).json({ error: e.code });
    }
    next(e);
  }
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
