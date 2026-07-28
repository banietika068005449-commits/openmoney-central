import { dispatcherFromToken } from './repo.js';

export async function requireDispatcher(req, res, next) {
  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'DISPATCHER_TOKEN_REQUIRED' });
  }
  try {
    const dispatcher = await dispatcherFromToken(token);
    if (!dispatcher) return res.status(401).json({ error: 'DISPATCHER_TOKEN_INVALID' });
    req.dispatcher = dispatcher;
    return next();
  } catch (error) {
    return next(error);
  }
}
