import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import {
  createAgent, listAgents, getAgentByPhone, getAgentById,
  resetAgentPin, setAgentActive, updateAgent, deleteAgent,
} from '../../repos/agent.repo.js';

const router = Router();
router.use(requireAdminToken);

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  city: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(4).max(20),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().min(4).max(20).optional(),
  isActive: z.boolean().optional(),
});

router.get('/', async (_req, res, next) => {
  try {
    res.json({ items: await listAgents() });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const existing = await getAgentByPhone(body.phone);
    if (existing) return res.status(409).json({ error: 'PHONE_ALREADY_EXISTS' });
    const agent = await createAgent(body);
    res.status(201).json(agent);
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    if (body.phone) {
      const other = await getAgentByPhone(body.phone);
      if (other && String(other.id) !== String(req.params.id)) {
        return res.status(409).json({ error: 'PHONE_ALREADY_EXISTS' });
      }
    }
    let agent = null;
    if (body.name != null || body.city != null || body.phone != null) {
      agent = await updateAgent(req.params.id, body);
    }
    if (body.isActive != null) {
      agent = await setAgentActive(req.params.id, body.isActive);
    }
    if (!agent) agent = await getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    res.json(agent);
  } catch (e) { next(e); }
});

router.post('/:id/reset-pin', async (req, res, next) => {
  try {
    const agent = await resetAgentPin(req.params.id);
    if (!agent) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    res.json(agent);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const ok = await deleteAgent(req.params.id);
    if (!ok) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
