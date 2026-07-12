import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import { listPendingFlags, ackSmsFlag, setSmsAdminProcessingStatus, clearSmsFlag } from '../../repos/sms.repo.js';
import { createNotification } from '../../repos/agentNotification.repo.js';

const ackSchema = z.object({ action: z.enum(['seen', 'searching', 'waiting']) });

const MESSAGES = {
  seen: "L'administrateur a vu votre signalement.",
  searching: 'Votre transaction signalee est en plein traitement.',
  waiting: 'Votre signalement a ete mis en attente.',
};

export default function flagsRouter() {
  const router = Router();
  router.use(requireAdminToken);

  // Signalements en attente de prise en compte (alerte flottante admin).
  router.get('/pending', async (_req, res, next) => {
    try {
      res.json({ items: await listPendingFlags() });
    } catch (e) { next(e); }
  });

  // Prise en compte d'un signalement : Vu / Rechercher (traitement) / En attente.
  router.post('/:id/ack', async (req, res, next) => {
    try {
      const { action } = ackSchema.parse(req.body);
      const flag = await ackSmsFlag(req.params.id);
      if (!flag) return res.status(404).json({ error: 'Signalement introuvable' });

      if (action === 'searching') {
        await setSmsAdminProcessingStatus(req.params.id, 'UNLOCKED');
        await clearSmsFlag(req.params.id);
      } else if (action === 'waiting') {
        await setSmsAdminProcessingStatus(req.params.id, 'EN_ATTENTE');
      }

      if (flag.agent_id) {
        await createNotification({
          agentId: flag.agent_id,
          type: 'flag_treated',
          phoneNumber: flag.phone_number,
          smsId: Number(req.params.id),
          transactionId: flag.transaction_id,
          message: MESSAGES[action],
        });
      }

      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return router;
}
