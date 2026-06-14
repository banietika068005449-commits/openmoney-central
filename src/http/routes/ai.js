import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../analysis/providers/ai.js';
import {
  listProviders, getProviderById, createProvider, updateProvider, deleteProvider,
  listKeys, createKey, updateKey, deleteKey,
} from '../../repos/aiProvider.repo.js';

const router = Router();
router.use(requireAdminToken);

router.get('/default-prompt', (_req, res) => {
  res.json({ prompt: DEFAULT_SYSTEM_PROMPT });
});

// ---- Providers ----

const providerCreateSchema = z.object({
  name:         z.string().min(1).max(200),
  providerType: z.enum(['openai', 'anthropic', 'google', 'mistral', 'custom']),
  model:        z.string().min(1).max(200),
  baseUrl:      z.string().url().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
});

const providerUpdateSchema = providerCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
});

router.get('/providers', async (_req, res, next) => {
  try { res.json(await listProviders()); } catch (e) { next(e); }
});

router.get('/providers/:id', async (req, res, next) => {
  try {
    const p = await getProviderById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Provider introuvable' });
    res.json(p);
  } catch (e) { next(e); }
});

router.post('/providers', async (req, res, next) => {
  try {
    const data = providerCreateSchema.parse(req.body);
    const p = await createProvider(data);
    res.status(201).json(p);
  } catch (e) { next(e); }
});

router.patch('/providers/:id', async (req, res, next) => {
  try {
    const patch = providerUpdateSchema.parse(req.body);
    const p = await updateProvider(req.params.id, patch);
    if (!p) return res.status(404).json({ error: 'Provider introuvable' });
    res.json(p);
  } catch (e) { next(e); }
});

router.delete('/providers/:id', async (req, res, next) => {
  try {
    const ok = await deleteProvider(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Provider introuvable' });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ---- Keys ----

const keyCreateSchema = z.object({
  label:  z.string().max(120).nullable().optional(),
  apiKey: z.string().min(1).max(2000),
});

const keyUpdateSchema = z.object({
  label:    z.string().max(120).nullable().optional(),
  apiKey:   z.string().min(1).max(2000).optional(),
  isActive: z.boolean().optional(),
});

router.get('/providers/:providerId/keys', async (req, res, next) => {
  try { res.json(await listKeys(req.params.providerId)); } catch (e) { next(e); }
});

router.post('/providers/:providerId/keys', async (req, res, next) => {
  try {
    const data = keyCreateSchema.parse(req.body);
    const k = await createKey(req.params.providerId, data);
    res.status(201).json(k);
  } catch (e) { next(e); }
});

router.patch('/keys/:id', async (req, res, next) => {
  try {
    const patch = keyUpdateSchema.parse(req.body);
    const k = await updateKey(req.params.id, patch);
    if (!k) return res.status(404).json({ error: 'Cle introuvable' });
    res.json(k);
  } catch (e) { next(e); }
});

router.delete('/keys/:id', async (req, res, next) => {
  try {
    const ok = await deleteKey(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Cle introuvable' });
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
