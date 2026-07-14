import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import { getAgentById } from '../../repos/agent.repo.js';
import {
  createOpenChatMessage,
  listOpenChatConversations,
  listOpenChatMessages,
  markOpenChatRead,
} from '../../repos/agentChat.repo.js';

const router = Router();
router.use(requireAdminToken);

const listSchema = z.object({
  after: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
});

const messageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

router.get('/conversations', async (_req, res, next) => {
  try {
    res.json({ items: await listOpenChatConversations() });
  } catch (e) { next(e); }
});

router.get('/conversations/:agentId/messages', async (req, res, next) => {
  try {
    const agent = await getAgentById(req.params.agentId);
    if (!agent) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    const q = listSchema.parse(req.query);
    res.json({ items: await listOpenChatMessages(req.params.agentId, q) });
  } catch (e) { next(e); }
});

router.post('/conversations/:agentId/messages', async (req, res, next) => {
  try {
    const agent = await getAgentById(req.params.agentId);
    if (!agent) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    const body = messageSchema.parse(req.body);
    const message = await createOpenChatMessage(req.params.agentId, 'admin', body.body);
    res.status(201).json(message);
  } catch (e) { next(e); }
});

router.post('/conversations/:agentId/read', async (req, res, next) => {
  try {
    const agent = await getAgentById(req.params.agentId);
    if (!agent) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    res.json(await markOpenChatRead(req.params.agentId, 'admin'));
  } catch (e) { next(e); }
});

export default router;
