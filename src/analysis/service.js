import { insertAnalysis, getPendingSmsIds } from '../db.js';

// Orchestration de l'analyse SMS.
// - analyzeOne(smsId)  : analyse transactionnelle d'un SMS (utilise inline ou en rattrapage)
// - analyzePending()   : filet de rattrapage pour les SMS coinces en status='received'
//
// Garanties transactionnelles :
//   BEGIN
//     SELECT ... FOR UPDATE SKIP LOCKED   (evite double traitement concurrent)
//     UPDATE sms SET status='processing'
//     INSERT INTO sms_analysis ...        (ON CONFLICT DO UPDATE -> idempotent)
//     UPDATE sms SET status='analyzed' | 'ignored'
//   COMMIT
//
// En cas d'erreur dans le provider : ROLLBACK puis UPDATE sms SET status='failed'
// dans une connexion separee pour ne pas dependre du commit transactionnel.

export class SmsAnalysisService {
  /**
   * @param {{
   *   pool: import('pg').Pool,
   *   registry: { pick: (sender:string, content:string) => any },
   *   logger?: { info:Function, warn:Function, error:Function },
   * }} deps
   */
  constructor({ pool, registry, logger = console }) {
    this.pool = pool;
    this.registry = registry;
    this.logger = logger;
  }

  /**
   * Analyse un SMS deja insere. Renvoie le resultat, ou null si le SMS
   * n'etait pas eligible (statut deja final, lock concurrent, etc.).
   * @param {number|string|bigint} smsId
   * @returns {Promise<import('./types.js').SmsAnalysisResult | null>}
   */
  async analyzeOne(smsId) {
    const client = await this.pool.connect();
    let locked = false;
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT id, sender, content, status FROM sms
         WHERE id = $1 AND status IN ('received','failed')
         FOR UPDATE SKIP LOCKED`,
        [smsId],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      locked = true;
      const sms = rows[0];

      await client.query(`UPDATE sms SET status='processing' WHERE id=$1`, [smsId]);

      const provider = this.registry.pick(sms.sender, sms.content);
      if (!provider) {
        // Ne devrait jamais arriver : UnknownSmsAnalyzer matche toujours.
        throw new Error('Aucun provider disponible (registry mal configuree ?)');
      }

      /** @type {import('./types.js').SmsAnalysisResult} */
      const result = await provider.analyze(sms.sender, sms.content);

      // OpenMoney ne traite que les depots d'argent. Tout SMS qui n'est pas
      // money_received est explicitement marque ignored, meme si le provider
      // l'a reconnu (ex. money_sent, payment, balance_check, notification...).
      if (result.smsType !== 'money_received' && result.analysisStatus !== 'ignored') {
        result.analysisStatus = 'ignored';
      }

      await insertAnalysis(client, smsId, result);

      const finalStatus = result.analysisStatus === 'ignored' ? 'ignored' : 'analyzed';
      await client.query(`UPDATE sms SET status=$1 WHERE id=$2`, [finalStatus, smsId]);

      await client.query('COMMIT');
      this.logger.info?.(`[analysis] sms_id=${smsId} provider=${result.provider} type=${result.smsType} status=${finalStatus} confidence=${result.confidence}`);
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      this.logger.error?.(`[analysis] sms_id=${smsId} echec : ${err.message}`);
      if (locked) {
        // Marquer le SMS comme failed dans une nouvelle connexion (le client courant est rollback)
        try {
          await this.pool.query(`UPDATE sms SET status='failed' WHERE id=$1`, [smsId]);
        } catch (e2) {
          this.logger.error?.(`[analysis] sms_id=${smsId} echec UPDATE status=failed : ${e2.message}`);
        }
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Rattrape les SMS coinces en status='received'.
   * @param {number} limit
   * @returns {Promise<{ processed:number, errors:number }>}
   */
  async analyzePending(limit = 50) {
    const ids = await getPendingSmsIds({ limit, statuses: ['received'] });
    let processed = 0;
    let errors = 0;
    for (const id of ids) {
      try {
        const res = await this.analyzeOne(id);
        if (res) processed += 1;
      } catch (_) {
        errors += 1;
      }
    }
    this.logger.info?.(`[analysis] rattrapage : ${processed}/${ids.length} OK, ${errors} erreur(s)`);
    return { processed, errors };
  }
}
