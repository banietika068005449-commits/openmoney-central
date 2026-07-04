import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAdminToken, validateAdminCredential } from '../middleware/admin.js';
import { createAdminSession, consumeAdminSession, revokeAdminSession } from '../../repos/adminSession.repo.js';
import { loadRecaptchaConfig, RecaptchaError, verifyRecaptchaToken } from '../../services/recaptcha.service.js';
import { setRecaptchaSettings } from '../../repos/setting.repo.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
});

const loginSchema = z.object({
  adminToken: z.string().trim().min(1),
  captchaToken: z.string().trim().optional(),
});

const recaptchaConfigSchema = z.object({
  enabled: z.boolean(),
  siteKey: z.string().trim().max(2000).optional().default(''),
  secretKey: z.string().trim().max(2000).optional().default(''),
});

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' ? token : null;
}

function publicAdmin(adminAuth) {
  return {
    type: adminAuth.type,
    label: adminAuth.label || null,
  };
}

router.get('/recaptcha-site-key', async (_req, res, next) => {
  try {
    const { enabled, siteKey } = await loadRecaptchaConfig();
    res.json({ enabled, siteKey });
  } catch (e) {
    next(e);
  }
});

router.get('/recaptcha-config', requireAdminToken, async (_req, res, next) => {
  try {
    const { enabled, siteKey, secretKey } = await loadRecaptchaConfig();
    res.json({
      enabled,
      siteKey,
      secretConfigured: Boolean(secretKey),
    });
  } catch (e) {
    next(e);
  }
});

router.put('/recaptcha-config', requireAdminToken, async (req, res, next) => {
  try {
    const parsed = recaptchaConfigSchema.parse(req.body);
    await setRecaptchaSettings({
      enabled: parsed.enabled,
      siteKey: parsed.siteKey,
      secretKey: parsed.secretKey,
      updateSecret: Boolean(parsed.secretKey) || !parsed.enabled,
    });
    const { enabled, siteKey, secretKey } = await loadRecaptchaConfig();
    res.json({
      enabled,
      siteKey,
      secretConfigured: Boolean(secretKey),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_LOGIN_REQUEST' });
    }

    const { enabled, secretKey, timeoutMs } = await loadRecaptchaConfig();
    if (enabled) {
      if (!parsed.data.captchaToken) {
        return res.status(400).json({ error: 'CAPTCHA_REQUIRED' });
      }

      try {
        await verifyRecaptchaToken({
          token: parsed.data.captchaToken,
          secretKey,
          remoteIp: req.ip,
          timeoutMs,
        });
      } catch (e) {
        if (e instanceof RecaptchaError) {
          if (e.code === 'CAPTCHA_VERIFICATION_FAILED') {
            console.error('[recaptcha] verification impossible :', e.message);
            return res.status(500).json({ error: e.code });
          }
          return res.status(400).json({ error: e.code });
        }
        throw e;
      }
    }

    const adminAuth = await validateAdminCredential(parsed.data.adminToken);
    if (!adminAuth) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }

    const { token, session } = await createAdminSession(adminAuth);
    return res.status(201).json({
      token,
      expiresAt: session.expires_at,
      admin: publicAdmin(adminAuth),
    });
  } catch (e) {
    return next(e);
  }
});

router.get('/session', async (req, res, next) => {
  try {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'SESSION_INVALID' });

    const result = await consumeAdminSession(token);
    if (!result.ok) {
      const code = result.reason === 'expired' ? 'SESSION_EXPIRED' : 'SESSION_INVALID';
      return res.status(401).json({ error: code });
    }

    return res.json({
      ok: true,
      expiresAt: result.session.expires_at,
      admin: publicAdmin(result.adminAuth),
    });
  } catch (e) {
    return next(e);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token = bearerToken(req);
    if (token) await revokeAdminSession(token);
    return res.status(204).end();
  } catch (e) {
    return next(e);
  }
});

export default router;
