// Verifie le token Bearer partage avec les points de vente.
// Le token est compare en temps constant pour eviter les attaques par timing.
import { timingSafeEqual } from 'node:crypto';

export function requireIngestToken(req, res, next) {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'INGEST_TOKEN non configure cote serveur' });
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
