import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import { setSmsAdminProcessingStatus, clearSmsFlag, getSmsById } from '../../repos/sms.repo.js';
import { createNotification } from '../../repos/agentNotification.repo.js';
import { agentsArchiving } from '../../repos/agentArchive.repo.js';

const adminStatusSchema = z.object({
  status: z.enum(['ANALYSIS', 'UNLOCKED', 'TREATED', 'PROBLEM', 'NOUVEAU', 'EN_ATTENTE']),
});

// Message de notification agent selon le nouveau statut d'un numero archive.
const STATUS_MESSAGES = {
  NOUVEAU: 'Nouveau client : transaction recue.',
  EN_ATTENTE: 'Votre transaction a ete mise en attente.',
  UNLOCKED: 'Votre transaction est en plein traitement.',
  TREATED: 'Votre transaction a ete traitee.',
  PROBLEM: 'Votre transaction est signalee comme probleme.',
  ANALYSIS: 'Votre transaction est en cours d\'analyse.',
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
          for (const agentId of agentIds) {
            await createNotification({
              agentId,
              type: status === 'PROBLEM' ? 'flag' : 'status_change',
              phoneNumber: phone,
              smsId: updated.id,
              transactionId: full?.transaction_id,
              message: STATUS_MESSAGES[status] || 'Statut de votre transaction mis a jour.',
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
