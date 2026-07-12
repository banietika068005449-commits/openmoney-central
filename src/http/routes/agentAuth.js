import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  getAgentByPhone, setAgentPin, verifyAgentPin, touchLastLogin,
} from '../../repos/agent.repo.js';
import { createAgentSession, consumeAgentSession, revokeAgentSession } from '../../repos/agentSession.repo.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.AGENT_LOGIN_RATE_LIMIT_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
});

const phoneSchema = z.object({ phone: z.string().trim().min(4).max(20) });
const credentialsSchema = z.object({
  phone: z.string().trim().min(4).max(20),
  pin: z.string().trim().regex(/^\d{4,8}$/),
});

function publicAgent(agent) {
  return { id: agent.id, name: agent.name, city: agent.city, phone: agent.phone };
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' ? token : null;
}

// Determine l'ecran a afficher : creer un PIN (1ere fois) ou saisir le PIN.
router.post('/status', authLimiter, async (req, res, next) => {
  try {
    const parsed = phoneSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
    const agent = await getAgentByPhone(parsed.data.phone);
    if (!agent || !agent.is_active) {
      return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    }
    return res.json({ exists: true, pinSet: !agent.must_set_pin, name: agent.name, photoUrl: agent.photo_url });
  } catch (e) { next(e); }
});

// 1ere connexion : l'agent choisit son PIN.
router.post('/set-pin', authLimiter, async (req, res, next) => {
  try {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
    const agent = await getAgentByPhone(parsed.data.phone);
    if (!agent || !agent.is_active) {
      return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    }
    if (!agent.must_set_pin) {
      return res.status(409).json({ error: 'PIN_ALREADY_SET' });
    }
    await setAgentPin(agent.id, parsed.data.pin);
    await touchLastLogin(agent.id);
    const { token, session } = await createAgentSession(agent.id);
    return res.status(201).json({ token, expiresAt: session.expires_at, agent: publicAgent(agent) });
  } catch (e) { next(e); }
});

// Connexion telephone + PIN.
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
    const agent = await getAgentByPhone(parsed.data.phone);
    if (!agent || !agent.is_active) {
      return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    }
    if (agent.must_set_pin) {
      return res.status(409).json({ error: 'PIN_NOT_SET' });
    }
    if (!verifyAgentPin(agent, parsed.data.pin)) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    }
    await touchLastLogin(agent.id);
    const { token, session } = await createAgentSession(agent.id);
    return res.json({ token, expiresAt: session.expires_at, agent: publicAgent(agent) });
  } catch (e) { next(e); }
});

router.get('/session', async (req, res, next) => {
  try {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'SESSION_INVALID' });
    const result = await consumeAgentSession(token);
    if (!result.ok) {
      const code = result.reason === 'expired' ? 'SESSION_EXPIRED' : 'SESSION_INVALID';
      return res.status(401).json({ error: code });
    }
    return res.json({ ok: true, expiresAt: result.session.expires_at, agentId: result.agentAuth.id });
  } catch (e) { next(e); }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token = bearerToken(req);
    if (token) await revokeAgentSession(token);
    return res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
