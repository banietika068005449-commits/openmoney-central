import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import { setSmsAdminProcessingStatus, clearSmsFlag, getSmsById } from '../../repos/sms.repo.js';
import { createNotification } from '../../repos/agentNotification.repo.js';
import { agentsArchiving } from '../../repos/agentArchive.repo.js';
import { transactionMessage } from '../../repos/agentNotifyText.js';

const adminStatusSchema = z.object({
  status: z.enum(['ANALYSIS', 'UNLOCKED', 'TREATED', 'PROBLEM', 'NOUVEAU', 'EN_ATTENTE']),
});

// Action decrite selon le nouveau statut (le prefixe numero+montant+ref est ajoute).
const STATUS_ACTIONS = {
  NOUVEAU: 'nouveau client, transaction recue',
  EN_ATTENTE: 'mise en attente',
  UNLOCKED: 'en plein traitement',
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

      // Notifier l'agent proprietaire du numero (archive) a CHAQUE changement de
      // statut. Best-effort, ne bloque pas la reponse.
      try {
        const full = await getSmsById(updated.id);
        const phone = full?.phone_number;
        if (phone) {
          const agentIds = await agentsArchiving(phone);
          const action = STATUS_ACTIONS[status] || 'statut mis a jour';
          for (const agentId of agentIds) {
            await createNotification({
              agentId,
              type: status === 'PROBLEM' ? 'flag' : 'status_change',
              phoneNumber: phone,
              smsId: updated.id,
              transactionId: full?.transaction_id,
              message: transactionMessage(full, action),
            });
          }
        }
        // Signalement traite : nettoyer le marqueur quand on quitte PROBLEM.
        if (status !== 'PROBLEM' && updated.flagged_by_agent_id) {
          await clearSmsFlag(updated.id);
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
