import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import { listPendingFlags, ackSmsFlag, setSmsAdminProcessingStatus, clearSmsFlag, getSmsById } from '../../repos/sms.repo.js';
import { createNotification } from '../../repos/agentNotification.repo.js';
import { transactionMessage } from '../../repos/agentNotifyText.js';

const ackSchema = z.object({ action: z.enum(['seen', 'searching', 'waiting']) });

const ACTIONS = {
  seen: 'vue par l\'administrateur',
  searching: 'debloquee',
  waiting: 'mise en attente',
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
        const full = await getSmsById(req.params.id);
        await createNotification({
          agentId: flag.agent_id,
          type: 'flag_treated',
          phoneNumber: flag.phone_number,
          smsId: Number(req.params.id),
          transactionId: flag.transaction_id,
          message: transactionMessage(full, ACTIONS[action]),
        });
      }

      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return router;
}
