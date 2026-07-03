// Auth Bearer pour les endpoints dashboard (/sms, /ai).
// Le login valide ADMIN_TOKEN / access_token, puis les routes protegees
// n'acceptent que des sessions courtes creees cote serveur.
import { timingSafeEqual } from 'node:crypto';
import { findActiveAccessToken, markAccessTokenUsed } from '../../repos/accessToken.repo.js';
import { consumeAdminSession } from '../../repos/adminSession.repo.js';

export function matchesBootstrapToken(token) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function validateAdminCredential(token) {
  if (!token) return null;

  if (matchesBootstrapToken(token)) {
    return { type: 'bootstrap' };
  }

  const accessToken = await findActiveAccessToken(token);
  if (!accessToken) return null;

  markAccessTokenUsed(accessToken.id).catch((e) => {
    console.error('[auth] mise a jour last_used_at impossible :', e.message);
  });

  return { type: 'access_token', id: accessToken.id, label: accessToken.label };
}

export async function requireAdminToken(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  try {
    const session = await consumeAdminSession(token);
    if (!session.ok) {
      if (session.reason === 'expired') {
        return res.status(401).json({ error: 'SESSION_EXPIRED' });
      }
      return res.status(401).json({ error: 'SESSION_INVALID' });
    }
    req.adminAuth = session.adminAuth;
    req.adminSession = session.session;
    return next();
  } catch (e) {
    return next(e);
  }
}
