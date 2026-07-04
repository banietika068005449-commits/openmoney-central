import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getRecaptchaSettings } from '../repos/setting.repo.js';

const DEFAULT_KEY_FILE = resolve(process.cwd(), '..', 'recaptchat google KEY', 'KEY.txt');

export class RecaptchaError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'RecaptchaError';
    this.code = code;
  }
}

function parseKeyFile(content) {
  const entries = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([^=#]+)\s*=\s*(.+?)\s*$/);
    if (match) entries[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return {
    siteKey: entries.key_site || entries.site_key || entries.recaptcha_site_key || '',
    secretKey: entries.key_secret || entries.secret_key || entries.recaptcha_secret_key || '',
  };
}

export async function loadRecaptchaConfig() {
  let fileConfig = { siteKey: '', secretKey: '' };
  const keyFile = process.env.RECAPTCHA_KEY_FILE || DEFAULT_KEY_FILE;
  const dbConfig = await getRecaptchaSettings();

  try {
    fileConfig = parseKeyFile(readFileSync(keyFile, 'utf8'));
  } catch (e) {
    if (process.env.RECAPTCHA_KEY_FILE) {
      console.error('[recaptcha] fichier de cles illisible :', e.message);
    }
  }

  return {
    enabled: dbConfig.enabled ?? true,
    siteKey: dbConfig.siteKey || process.env.RECAPTCHA_SITE_KEY || fileConfig.siteKey,
    secretKey: dbConfig.secretKey || process.env.RECAPTCHA_SECRET_KEY || fileConfig.secretKey,
    timeoutMs: Number(process.env.RECAPTCHA_TIMEOUT_MS || 4000),
  };
}

function mapGoogleError(errorCodes = []) {
  if (errorCodes.includes('missing-input-response')) return 'CAPTCHA_REQUIRED';
  if (errorCodes.includes('timeout-or-duplicate')) return 'CAPTCHA_EXPIRED';
  return 'CAPTCHA_INVALID';
}

export async function verifyRecaptchaToken({
  token,
  secretKey,
  remoteIp,
  fetchImpl = fetch,
  timeoutMs = 4000,
} = {}) {
  if (!token) throw new RecaptchaError('CAPTCHA_REQUIRED');
  if (!secretKey) throw new RecaptchaError('CAPTCHA_VERIFICATION_FAILED', 'Secret reCAPTCHA manquant');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  try {
    const response = await fetchImpl('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new RecaptchaError('CAPTCHA_VERIFICATION_FAILED', `HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!payload.success) {
      throw new RecaptchaError(mapGoogleError(payload['error-codes']));
    }

    return true;
  } catch (e) {
    if (e instanceof RecaptchaError) throw e;
    throw new RecaptchaError('CAPTCHA_VERIFICATION_FAILED', e.message);
  } finally {
    clearTimeout(timeout);
  }
}
