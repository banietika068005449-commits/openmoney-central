import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validateAdminCredential } from '../middleware/admin.js';
import { createAdminSession, consumeAdminSession, revokeAdminSession } from '../../repos/adminSession.repo.js';
import { loadRecaptchaConfig, RecaptchaError, verifyRecaptchaToken } from '../../services/recaptcha.service.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
});

const loginSchema = z.object({
  adminToken: z.string().trim().min(1),
  captchaToken: z.string().trim().min(1),
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

router.get('/recaptcha-site-key', (_req, res) => {
  const { siteKey } = loadRecaptchaConfig();
  res.json({ siteKey });
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    if (!req.body?.captchaToken) {
      return res.status(400).json({ error: 'CAPTCHA_REQUIRED' });
    }

    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'INVALID_LOGIN_REQUEST' });
    }

    const { secretKey, timeoutMs } = loadRecaptchaConfig();
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
