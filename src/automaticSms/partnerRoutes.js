import { Router } from 'express';
import { z } from 'zod';
import { normalizeCongoPhone } from './phone.js';
import { verifyPartnerSignature } from './signature.js';
import {
  auditIngress,
  consumeNonce,
  createDispatchRequest,
  findActivePartnerKey,
  partnerTemplate,
  recipientOptedOut,
} from './repo.js';

const router = Router();

const requestSchema = z.object({
  partnerId: z.string().trim().min(1).max(80),
  requestId: z.string().trim().min(1).max(120),
  campaignId: z.string().trim().min(1).max(120),
  templateId: z.string().trim().min(1).max(120),
  phoneNumber: z.string().trim().min(1).max(40),
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  consent: z.object({
    reference: z.string().trim().min(3).max(200),
    capturedAt: z.string().datetime({ offset: true }),
    source: z.enum(['tecno_contract', 'tecno_manual']),
    version: z.string().trim().min(3).max(80),
  }),
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
  let audit = {
    partnerId: String(req.body?.partnerId || ''),
    keyId: header(req, 'X-OpenMoney-Key-Id'),
    requestId: String(req.body?.requestId || ''),
    campaignId: String(req.body?.campaignId || ''),
    normalizedPhone: null,
  };
  const reject = async (status, error, extra = {}) => {
    await auditIngress({ ...audit, outcome: error, httpStatus: status }).catch(() => {});
    return res.status(status).json({ error, ...extra });
  };
  try {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return reject(400, 'INVALID_REQUEST', { details: parsed.error.flatten() });
    const body = parsed.data;
    const partnerId = header(req, 'X-OpenMoney-Partner-Id');
    const keyId = header(req, 'X-OpenMoney-Key-Id');
    const timestamp = header(req, 'X-OpenMoney-Timestamp');
    const nonce = header(req, 'X-OpenMoney-Nonce');
    const signature = header(req, 'X-OpenMoney-Signature');
    if (!partnerId || !keyId || !timestamp || !nonce || !signature) {
      return reject(401, 'SIGNATURE_HEADERS_REQUIRED');
    }
    audit = { ...audit, partnerId, keyId };
    if (partnerId !== body.partnerId) return reject(400, 'PARTNER_MISMATCH');

    const timestampMs = Number(timestamp) * 1000;
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) {
      return reject(401, 'TIMESTAMP_INVALID');
    }
    const expiresAt = new Date(body.expiresAt);
    const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : new Date();
    if (expiresAt <= new Date() || expiresAt <= scheduledAt ||
        expiresAt.getTime() > scheduledAt.getTime() + 7 * 86_400_000 + 1_000) {
      return reject(400, 'EXPIRATION_INVALID');
    }
    const capturedAt = new Date(body.consent.capturedAt);
    if (capturedAt > new Date(timestampMs + 5 * 60_000) ||
        capturedAt < new Date(timestampMs - 365 * 86_400_000)) {
      return reject(400, 'CONSENT_INVALID');
    }

    const key = await findActivePartnerKey(partnerId, keyId);
    if (!key || !key.is_active || !key.partner_active) {
      return reject(401, 'PARTNER_OR_KEY_INACTIVE');
    }
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body), 'utf8');
    const validSignature = verifyPartnerSignature({
      partnerId, keyId, timestamp, nonce, signature,
      rawBody, publicKeyPem: key.public_key_pem,
    });
    if (!validSignature) return reject(401, 'SIGNATURE_INVALID');
    if (!(await consumeNonce(keyId, nonce))) return reject(409, 'NONCE_REPLAYED');

    const normalizedPhone = normalizeCongoPhone(body.phoneNumber);
    audit.normalizedPhone = normalizedPhone;
    if (!normalizedPhone) return reject(400, 'PHONE_INVALID');
    if (await recipientOptedOut(normalizedPhone)) return reject(403, 'RECIPIENT_OPTED_OUT');
    const template = await partnerTemplate(partnerId, body.templateId);
    if (!template) return reject(400, 'TEMPLATE_NOT_ALLOWED');
    const variableError = validateVariables(template.variable_schema, body.variables);
    if (variableError) return reject(400, variableError);
    const openMoneyDownloadUrl = String(process.env.OPENMONEY_APP_DOWNLOAD_URL || '').trim();
    if (template.body.includes('{{openMoneyDownloadUrl}}') && !openMoneyDownloadUrl) {
      return reject(503, 'DOWNLOAD_URL_NOT_CONFIGURED');
    }
    const renderedText = renderTemplate(template.body, {
      ...body.variables,
      openMoneyDownloadUrl,
    });
    if (!renderedText.trim() || renderedText.length > 918) {
      return reject(400, 'MESSAGE_TOO_LONG');
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
      return reject(409, 'REQUEST_ID_CONFLICT');
    }
    const responseStatus = result.existing ? 200 : 202;
    await auditIngress({ ...audit, outcome: result.duplicateRecipient ? 'DUPLICATE_RECIPIENT' : 'ACCEPTED', httpStatus: responseStatus });
    return res.status(responseStatus).json({
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
