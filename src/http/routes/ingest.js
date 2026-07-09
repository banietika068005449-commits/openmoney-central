import { Router } from 'express';
import { z } from 'zod';
import { requireIngestToken } from '../middleware/auth.js';
import { ingest } from '../../ingest/service.js';
import { pool } from '../../db.js';

const router = Router();

const schema = z.object({
  pointDeVente: z.string().min(1).max(64),
  messages: z.array(z.object({
    uuid: z.string().uuid(),
    empreinte: z.string().length(64).regex(/^[a-f0-9]{64}$/i, 'sha256 hex attendu'),
    numeroTel: z.string().min(1).max(20),
    message: z.string().min(1).max(5000),
    smsRecuLe: z.string().datetime().nullish(),
  })).max(500),
});

router.post('/ingest', requireIngestToken, async (req, res, next) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Payload invalide',
      details: parsed.error.flatten(),
    });
  }
  try {
    const result = await ingest(parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

const analysisQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(200),
  offset: z.coerce.number().int().nonnegative().default(0),
  operator: z.string().optional(),
  q: z.string().optional(),
  from: z.string().datetime().optional(),
});

function buildAnalysisWhere(filters) {
  const where = [
    // 'treated' = depot analyse dont le numero a ete copie cote dashboard.
    // C'est un sous-etat de 'analyzed' : il doit rester visible dans
    // l'historique et compte dans la somme des depots. Sans ce IN, copier un
    // numero faisait disparaitre la transaction et baisser le total.
    // Pas de condition sur a.analysis_status : les KPI du module transactions
    // admin (sms.repo.js listSms stats) n'en ont pas non plus. L'app mobile
    // doit afficher exactement les memes transactions et le meme montant.
    "s.status IN ('analyzed', 'treated')",
  ];
  const params = [];

  if (filters.operator) {
    params.push(filters.operator);
    where.push(`a.operator = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    where.push(`(s.sender ILIKE $${params.length} OR s.content ILIKE $${params.length} OR a.phone_number ILIKE $${params.length} OR a.reference ILIKE $${params.length})`);
  }
  if (filters.from) {
    params.push(filters.from);
    where.push(`s.received_at >= $${params.length}`);
  }

  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

router.get('/analysis/summary', requireIngestToken, async (req, res, next) => {
  const parsed = analysisQuerySchema.omit({ limit: true, offset: true }).safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Filtres invalides', details: parsed.error.flatten() });
  }

  try {
    const { whereSql, params } = buildAnalysisWhere(parsed.data);
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COALESCE(SUM(a.amount), 0)::float8 AS somme_depots,
         (SELECT COUNT(*)::int FROM sms) AS total_sms
       FROM sms s
       JOIN sms_analysis a ON a.sms_id = s.id
       ${whereSql}`,
      params,
    );
    res.json({
      total: rows[0]?.total ?? 0,
      sommeDepots: rows[0]?.somme_depots ?? 0,
      // Meme valeur que le KPI "Total" du module transactions admin
      // (sms.repo.js listSms stats) : nombre global de SMS, sans filtre.
      totalSms: rows[0]?.total_sms ?? 0,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/analysis/sms', requireIngestToken, async (req, res, next) => {
  const parsed = analysisQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Filtres invalides', details: parsed.error.flatten() });
  }

  try {
    const { limit, offset, ...filters } = parsed.data;
    const { whereSql, params } = buildAnalysisWhere(filters);
    const totalQ = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM sms s
       JOIN sms_analysis a ON a.sms_id = s.id
       ${whereSql}`,
      params,
    );

    params.push(limit, offset);
    const itemsQ = await pool.query(
      `SELECT
         s.id, s.sender, s.content, s.received_at, s.point_de_vente,
         a.operator, a.amount, a.currency, a.phone_number, a.reference, a.transaction_id
       FROM sms s
       JOIN sms_analysis a ON a.sms_id = s.id
       ${whereSql}
       ORDER BY s.received_at DESC, s.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    res.json({
      items: itemsQ.rows,
      total: totalQ.rows[0]?.total ?? 0,
      limit,
      offset,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
