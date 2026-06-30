import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import { setSmsAdminProcessingStatus } from '../../repos/sms.repo.js';

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
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
