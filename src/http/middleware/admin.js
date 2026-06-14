// Auth Bearer ADMIN_TOKEN pour les endpoints dashboard (/sms, /ai).
// Compare en temps constant. Distinct d'INGEST_TOKEN qui est reserve aux PDV.
import { timingSafeEqual } from 'node:crypto';

export function requireAdminToken(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'ADMIN_TOKEN non configure cote serveur' });
  }
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Token manquant' });
  }
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Token invalide' });
  }
  next();
}
