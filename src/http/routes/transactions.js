import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import { setSmsAdminProcessingStatus, getSmsById } from '../../repos/sms.repo.js';
import { createNotification } from '../../repos/agentNotification.repo.js';
import { agentsArchiving } from '../../repos/agentArchive.repo.js';
import { transactionMessage } from '../../repos/agentNotifyText.js';

// 5 statuts canoniques (EN_ATTENTE retire).
const adminStatusSchema = z.object({
  status: z.enum(['ANALYSIS', 'UNLOCKED', 'TREATED', 'PROBLEM', 'NOUVEAU']),
});

// Action decrite selon le nouveau statut (le prefixe numero+montant+ref est ajoute).
const STATUS_ACTIONS = {
  NOUVEAU: 'nouveau client, transaction recue',
  UNLOCKED: 'debloquee',
  TREATED: 'traitee',
  PROBLEM: 'signalee comme probleme',
  ANALYSIS: 'en cours d\'analyse',
};

export default function transactionsRouter() {
  const router = Router();
  router.use(requireAdminToken);

  router.patch('/:id/admin-processing-status', async (req, res, next) => {
    try {
      const { status } = adminStatusSchema.parse(req.body);
      const updated = await setSmsAdminProcessingStatus(req.params.id, status);
      if (!updated) return res.status(404).json({ error: 'Transaction introuvable' });

      // Notifications best-effort (ne bloque pas la reponse).
      try {
        const full = await getSmsById(updated.id);
        const phone = full?.phone_number;
        const notified = new Set();

        // Transaction signalee puis DEBLOQUEE par l'admin : notifier l'agent
        // signalant (« le numero X a ete debloque »). Le marqueur rouge est
        // deja efface par setSmsAdminProcessingStatus pour tout changement de statut.
        if (updated.flagged_by_agent_id && status === 'UNLOCKED') {
          await createNotification({
            agentId: updated.flagged_by_agent_id,
            type: 'flag_treated',
            phoneNumber: phone,
            smsId: updated.id,
            transactionId: full?.transaction_id,
            message: transactionMessage(full, 'debloquee'),
          });
          notified.add(String(updated.flagged_by_agent_id));
        }

        // Notifier les agents ayant archive ce numero (tout changement de statut).
        if (phone) {
          const agentIds = await agentsArchiving(phone);
          const action = STATUS_ACTIONS[status] || 'statut mis a jour';
          for (const agentId of agentIds) {
            if (notified.has(String(agentId))) continue;
            await createNotification({
              agentId,
              type: 'status_change',
              phoneNumber: phone,
              smsId: updated.id,
              transactionId: full?.transaction_id,
              message: transactionMessage(full, action),
            });
          }
        }
      } catch (notifyErr) {
        console.error('[transactions] notification statut impossible :', notifyErr.message);
      }

      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
