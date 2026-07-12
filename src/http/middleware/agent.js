// Auth Bearer pour les endpoints de l'app agent (/agent/*).
// Le login (telephone + PIN) cree une session courte cote serveur ; les routes
// protegees n'acceptent que ces sessions.
import { consumeAgentSession } from '../../repos/agentSession.repo.js';

export async function requireAgentToken(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  try {
    const session = await consumeAgentSession(token);
    if (!session.ok) {
      if (session.reason === 'expired') {
        return res.status(401).json({ error: 'SESSION_EXPIRED' });
      }
      return res.status(401).json({ error: 'SESSION_INVALID' });
    }
    req.agentAuth = session.agentAuth;
    req.agentSession = session.session;
    return next();
  } catch (e) {
    return next(e);
  }
}
