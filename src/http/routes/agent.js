import { Router } from 'express';
import { z } from 'zod';
import { requireAgentToken } from '../middleware/agent.js';
import { listSms, flagSmsByAgent, listArchivedTransactions } from '../../repos/sms.repo.js';
import { getAgentById } from '../../repos/agent.repo.js';
import { listArchives, addArchive, removeArchive } from '../../repos/agentArchive.repo.js';
import {
  listNotifications, unreadCount, markRead, markAllRead,
} from '../../repos/agentNotification.repo.js';
import { PushNotificationService } from '../../services/pushNotification.service.js';

const pushService = new PushNotificationService();

// Projection sure des colonnes de transaction exposees a l'agent (pas de contenu
// SMS brut, pas d'IMEI, etc. : uniquement ce qui sert a verifier un paiement).
function toAgentTransaction(row) {
  return {
    id: row.id,
    received_at: row.received_at,
    amount: row.amount,
    currency: row.currency,
    operator: row.analysis_operator,
    sender: row.sender,
    phone_number: row.phone_number,
    transaction_id: row.transaction_id,
    reference: row.reference,
    // Note lisible par l'agent (lecture seule) : celle editee par l'admin
    // (sms_note via la NoteSidebar) en priorite, sinon la note de transaction.
    note: row.sms_note || row.transaction_note || '',
    tecno_auto: row.tecno_auto,
    admin_processing_status: row.admin_processing_status,
    flagged: !!row.flagged,
  };
}

export default function agentRouter() {
  const router = Router();
  router.use(requireAgentToken);

  const listSchema = z.object({
    phone: z.string().trim().optional(),
    transactionId: z.string().trim().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    period: z.enum(['all', 'days', 'week']).optional().default('all'),
    sort: z.enum(['recent', 'ancient']).optional().default('recent'),
    limit: z.coerce.number().int().positive().max(200).default(50),
    offset: z.coerce.number().int().nonnegative().default(0),
  });

  router.get('/me', async (req, res, next) => {
    try {
      const agent = await getAgentById(req.agentAuth.id);
      if (!agent) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
      res.json(agent);
    } catch (e) { next(e); }
  });

  // Recherche des transactions (reutilise listSms de l'admin).
  router.get('/transactions', async (req, res, next) => {
    try {
      const f = listSchema.parse(req.query);
      const r = await listSms({ ...f, status: undefined });
      res.json({
        items: r.items.map(toAgentTransaction),
        total: r.total,
        limit: r.limit,
        offset: r.offset,
        sommeDepots: r.stats.sommeDepots,
      });
    } catch (e) { next(e); }
  });

  // Signalement d'une transaction (cloche).
  router.post('/transactions/:id/flag', async (req, res, next) => {
    try {
      const flagged = await flagSmsByAgent(req.params.id, req.agentAuth.id);
      if (!flagged) return res.status(404).json({ error: 'Transaction introuvable' });
      // Alerte push navigateur cote admin (best-effort, ne bloque pas la reponse).
      pushService.sendToAll({
        title: 'Transaction signalee',
        body: `Un agent a signale la transaction ${flagged.phone_number || `#${flagged.id}`}.`,
        tag: 'openmoney-agent-flag',
        url: '/',
      }).catch((e) => console.error('[agent] push admin flag impossible :', e.message));
      res.json({ ok: true, id: flagged.id });
    } catch (e) { next(e); }
  });

  // Toutes les transactions des numeros archives par l'agent (+ total).
  router.get('/archived-transactions', async (req, res, next) => {
    try {
      const q = z.object({
        limit: z.coerce.number().int().positive().max(500).default(200),
        offset: z.coerce.number().int().nonnegative().default(0),
      }).parse(req.query);
      const r = await listArchivedTransactions(req.agentAuth.id, q);
      res.json({ items: r.items.map(toAgentTransaction), total: r.total });
    } catch (e) { next(e); }
  });

  // ---- Archives ----
  router.get('/archives', async (req, res, next) => {
    try {
      res.json({ items: await listArchives(req.agentAuth.id) });
    } catch (e) { next(e); }
  });

  router.post('/archives', async (req, res, next) => {
    try {
      const body = z.object({ phone: z.string().trim().min(4).max(20) }).parse(req.body);
      const result = await addArchive(req.agentAuth.id, body.phone);
      if (result.ok) return res.status(201).json(result.archive);
      if (result.reason === 'taken') return res.status(409).json({ error: 'ALREADY_ARCHIVED' });
      return res.status(400).json({ error: 'INVALID_PHONE' });
    } catch (e) { next(e); }
  });

  router.delete('/archives/:phone', async (req, res, next) => {
    try {
      const ok = await removeArchive(req.agentAuth.id, req.params.phone);
      if (!ok) return res.status(404).json({ error: 'Archive introuvable' });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  // ---- Notifications (polling) ----
  router.get('/notifications', async (req, res, next) => {
    try {
      const q = z.object({
        limit: z.coerce.number().int().positive().max(100).default(50),
        offset: z.coerce.number().int().nonnegative().default(0),
      }).parse(req.query);
      const [items, unread] = await Promise.all([
        listNotifications(req.agentAuth.id, q),
        unreadCount(req.agentAuth.id),
      ]);
      res.json({ items, unread });
    } catch (e) { next(e); }
  });

  router.get('/notifications/unread-count', async (req, res, next) => {
    try {
      res.json({ unread: await unreadCount(req.agentAuth.id) });
    } catch (e) { next(e); }
  });

  router.post('/notifications/:id/read', async (req, res, next) => {
    try {
      const updated = await markRead(req.params.id, req.agentAuth.id);
      if (!updated) return res.status(404).json({ error: 'Notification introuvable' });
      res.json(updated);
    } catch (e) { next(e); }
  });

  router.post('/notifications/read-all', async (req, res, next) => {
    try {
      await markAllRead(req.agentAuth.id);
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return router;
}
