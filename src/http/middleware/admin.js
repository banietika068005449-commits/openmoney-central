// Auth Bearer ADMIN_TOKEN pour les endpoints dashboard (/sms, /ai).
// Compare en temps constant. Distinct d'INGEST_TOKEN qui est reserve aux PDV.
import { timingSafeEqual } from 'node:crypto';
import { findActiveAccessToken, markAccessTokenUsed } from '../../repos/accessToken.repo.js';

function matchesBootstrapToken(token) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function requireAdminToken(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  if (matchesBootstrapToken(token)) {
    req.adminAuth = { type: 'bootstrap' };
    return next();
  }

  try {
    const accessToken = await findActiveAccessToken(token);
    if (!accessToken) {
      return res.status(401).json({ error: 'Token invalide' });
    }
    req.adminAuth = { type: 'access_token', id: accessToken.id, label: accessToken.label };
    // La date d'utilisation ne doit pas retarder la reponse authentifiee.
    markAccessTokenUsed(accessToken.id).catch((e) => {
      console.error('[auth] mise a jour last_used_at impossible :', e.message);
    });
    return next();
  } catch (e) {
    return next(e);
  }
}
