import { Router } from 'express';
import { z } from 'zod';
import { requireAdminToken } from '../middleware/admin.js';
import { getImprovementSettings, setImprovementSettings } from '../../repos/setting.repo.js';

const router = Router();
router.use(requireAdminToken);

const colorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

const amountRuleSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().max(80).optional().default(''),
  amount: z.coerce.number().positive().max(999999999),
  color: colorSchema,
});

const settingsSchema = z.object({
  amountRules: z.array(amountRuleSchema).max(80).default([]),
});

function normalizeRule(rule) {
  return {
    id: rule.id,
    label: rule.label || '',
    amount: Number(rule.amount),
    color: rule.color.toUpperCase(),
  };
}

router.get('/settings', async (_req, res, next) => {
  try {
    res.json(await getImprovementSettings());
  } catch (e) {
    next(e);
  }
});

router.put('/settings', async (req, res, next) => {
  try {
    const parsed = settingsSchema.parse(req.body);
    const amountRules = parsed.amountRules.map(normalizeRule);
    await setImprovementSettings({ amountRules });
    res.json({ amountRules });
  } catch (e) {
    next(e);
  }
});

export default router;
