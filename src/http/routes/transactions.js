import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import { setSmsAdminProcessingStatus, clearSmsFlag } from '../../repos/sms.repo.js';
import { createNotification } from '../../repos/agentNotification.repo.js';

const adminStatusSchema = z.object({
  status: z.enum(['ANALYSIS', 'UNLOCKED', 'TREATED', 'PROBLEM']),
});

export default function transactionsRouter() {
  const router = Router();
  router.use(requireAdminToken);

  router.patch('/:id/admin-processing-status', async (req, res, next) => {
    try {
      const { status } = adminStatusSchema.parse(req.body);
      const updated = await setSmsAdminProcessingStatus(req.params.id, status);
      if (!updated) return res.status(404).json({ error: 'Transaction introuvable' });

      // Signalement traite : notifier l'agent qui avait signale, puis effacer le
      // marqueur. On ne notifie que lorsqu'on quitte l'etat PROBLEM.
      if (status !== 'PROBLEM' && updated.flagged_by_agent_id) {
        try {
          await createNotification({
            agentId: updated.flagged_by_agent_id,
            type: 'flag_treated',
            smsId: updated.id,
            message: `Votre transaction signalee #${updated.id} a ete traitee par l'administrateur.`,
          });
          await clearSmsFlag(updated.id);
        } catch (notifyErr) {
          console.error('[transactions] notification flag_treated impossible :', notifyErr.message);
        }
      }

      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
