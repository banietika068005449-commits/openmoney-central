import { timingSafeEqual } from 'node:crypto';

export function requireAutomaticSmsToken(req, res, next) {
  const expected = process.env.AUTOMATIC_SMS_DISPATCHER_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'AUTOMATIC_SMS_DISPATCHER_TOKEN_NOT_CONFIGURED' });
  }
  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'DISPATCHER_TOKEN_REQUIRED' });
  }
  const provided = Buffer.from(token);
  const configured = Buffer.from(expected);
  if (provided.length !== configured.length || !timingSafeEqual(provided, configured)) {
    return res.status(401).json({ error: 'DISPATCHER_TOKEN_INVALID' });
  }
  return next();
}
