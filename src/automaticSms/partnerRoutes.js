import { Router } from 'express';
import { z } from 'zod';
import { normalizeCongoPhone } from './phone.js';
import { verifyPartnerSignature } from './signature.js';
import {
  activeTemplate,
  consumeNonce,
  createDispatchRequest,
  findActivePartnerKey,
} from './repo.js';

const router = Router();

const requestSchema = z.object({
  partnerId: z.string().trim().min(1).max(80),
  requestId: z.string().trim().min(1).max(120),
  campaignId: z.string().trim().min(1).max(120),
  templateId: z.string().trim().min(1).max(120),
  phoneNumber: z.string().trim().min(1).max(40),
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  expiresAt: z.string().datetime({ offset: true }),
});

function header(req, name) {
  return String(req.get(name) || '').trim();
}

function validateVariables(schema, variables) {
  const spec = schema && typeof schema === 'object' ? schema : {};
  const allowed = new Set(Object.keys(spec));
  for (const key of Object.keys(variables)) {
    if (!allowed.has(key)) return `VARIABLE_NOT_ALLOWED:${key}`;
  }
  for (const [key, rule] of Object.entries(spec)) {
    const value = variables[key];
    if (rule?.required && (value == null || String(value).trim() === '')) {
      return `VARIABLE_REQUIRED:${key}`;
    }
    if (value != null && String(value).length > Number(rule?.maxLength || 200)) {
      return `VARIABLE_TOO_LONG:${key}`;
    }
  }
  return null;
}

function renderTemplate(body, variables) {
  return body.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_match, key) => {
    if (!(key in variables)) throw Object.assign(new Error('VARIABLE_REQUIRED'), { code: `VARIABLE_REQUIRED:${key}` });
    return String(variables[key]);
  });
}

router.post('/requests', async (req, res, next) => {
  try {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
    const body = parsed.data;
    const partnerId = header(req, 'X-OpenMoney-Partner-Id');
    const keyId = header(req, 'X-OpenMoney-Key-Id');
    const timestamp = header(req, 'X-OpenMoney-Timestamp');
    const nonce = header(req, 'X-OpenMoney-Nonce');
    const signature = header(req, 'X-OpenMoney-Signature');
    if (!partnerId || !keyId || !timestamp || !nonce || !signature) {
      return res.status(401).json({ error: 'SIGNATURE_HEADERS_REQUIRED' });
    }
    if (partnerId !== body.partnerId) return res.status(400).json({ error: 'PARTNER_MISMATCH' });

    const timestampMs = Number(timestamp) * 1000;
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) {
      return res.status(401).json({ error: 'TIMESTAMP_INVALID' });
    }
    const expiresAt = new Date(body.expiresAt);
    const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : new Date();
    if (expiresAt <= new Date() || expiresAt <= scheduledAt || expiresAt.getTime() > timestampMs + 7 * 86_400_000) {
      return res.status(400).json({ error: 'EXPIRATION_INVALID' });
    }

    const key = await findActivePartnerKey(partnerId, keyId);
    if (!key || !key.is_active || !key.partner_active) {
      return res.status(401).json({ error: 'PARTNER_OR_KEY_INACTIVE' });
    }
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body), 'utf8');
    const validSignature = verifyPartnerSignature({
      partnerId, keyId, timestamp, nonce, signature,
      rawBody, publicKeyPem: key.public_key_pem,
    });
    if (!validSignature) return res.status(401).json({ error: 'SIGNATURE_INVALID' });
    if (!(await consumeNonce(keyId, nonce))) return res.status(409).json({ error: 'NONCE_REPLAYED' });

    const normalizedPhone = normalizeCongoPhone(body.phoneNumber);
    if (!normalizedPhone) return res.status(400).json({ error: 'PHONE_INVALID' });
    const template = await activeTemplate(body.templateId);
    if (!template) return res.status(400).json({ error: 'TEMPLATE_NOT_ALLOWED' });
    const variableError = validateVariables(template.variable_schema, body.variables);
    if (variableError) return res.status(400).json({ error: variableError });
    const openMoneyDownloadUrl = String(process.env.OPENMONEY_APP_DOWNLOAD_URL || '').trim();
    if (template.body.includes('{{openMoneyDownloadUrl}}') && !openMoneyDownloadUrl) {
      return res.status(503).json({ error: 'DOWNLOAD_URL_NOT_CONFIGURED' });
    }
    const renderedText = renderTemplate(template.body, {
      ...body.variables,
      openMoneyDownloadUrl,
    });
    if (!renderedText.trim() || renderedText.length > 918) {
      return res.status(400).json({ error: 'MESSAGE_TOO_LONG' });
    }

    const result = await createDispatchRequest({
      ...body,
      keyId,
      templateVersion: template.version,
      templateBody: template.body,
      normalizedPhone,
      renderedText,
      scheduledAt,
      expiresAt,
      rawBody: rawBody.toString('utf8'),
      signature,
      timestamp,
      nonce,
    });
    if (result.existing && !result.duplicateRecipient && result.item.raw_body !== rawBody.toString('utf8')) {
      return res.status(409).json({ error: 'REQUEST_ID_CONFLICT' });
    }
    return res.status(result.existing ? 200 : 202).json({
      id: result.item.id,
      requestId: result.item.request_id,
      campaignId: result.item.campaign_id,
      normalizedPhone: result.item.normalized_phone,
      templateVersion: result.item.template_version,
      status: result.duplicateRecipient ? 'DUPLICATE_RECIPIENT' : result.item.status,
      existing: result.existing,
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
