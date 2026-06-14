/// <reference path="../types.js" />

// Base abstraite des providers d'analyse SMS.
// Les providers concrets (MTN, Airtel, Unknown) surchargent canAnalyze + analyze
// et appellent les helpers ci-dessous.

const KW_AMOUNT = '(?:re(?:c|ç)u|cr[eé]dit[eé]?|envoy[eé]|d[eé]bit[eé]?|paiement|achat|pay[eé]|transfert|montant|retrait|d[eé]p[oô]t|cash[\\s\\-]?(?:in|out))';
const KW_BALANCE = '(?:nouveau\\s+solde|solde\\s+actuel|solde|balance|disponible)';
const CURRENCY = '(?:FCFA|XAF|XOF|F\\b)';
const AMOUNT_NUM = '(\\d[\\d\\s.,]*\\d|\\d)';

const RE_AMOUNT_BEFORE = new RegExp(`${KW_AMOUNT}[^0-9]{0,50}${AMOUNT_NUM}\\s*${CURRENCY}`, 'i');
const RE_AMOUNT_AFTER  = new RegExp(`${AMOUNT_NUM}\\s*${CURRENCY}[^0-9]{0,50}${KW_AMOUNT}`, 'i');
const RE_BAL_BEFORE    = new RegExp(`${KW_BALANCE}[^0-9]{0,50}${AMOUNT_NUM}\\s*${CURRENCY}`, 'i');
const RE_BAL_AFTER     = new RegExp(`${AMOUNT_NUM}\\s*${CURRENCY}[^0-9]{0,50}${KW_BALANCE}`, 'i');
const RE_PHONE         = /(\+\d{9,15}|\b\d{9,12}\b)/g;
const RE_REFERENCE     = /\b(?:r[eé]f(?:[eé]rence)?|reference)\s*[:.\-#]?\s*([A-Z0-9]{4,})/i;
const RE_TRANSACTION   = /\b(?:transaction|trans|tx|tnx|id)\s*[:.\-#]?\s*([A-Z0-9]{4,})/i;
const RE_CURRENCY      = /\b(FCFA|XAF|XOF)\b/i;

export class BaseSmsAnalyzer {
  /** @type {string} */ name = 'base';
  /** @type {string|null} */ operator = null;

  /**
   * @param {string} _sender
   * @param {string} _content
   * @returns {boolean}
   */
  canAnalyze(_sender, _content) { return false; }

  /**
   * @param {string} _sender
   * @param {string} _content
   * @returns {Promise<import('../types.js').SmsAnalysisResult>}
   */
  async analyze(_sender, _content) { throw new Error(`${this.name}: analyze() non implementee`); }

  // ------- helpers communs (surchargeables si besoin) -------

  /** Collapse des espaces, retire les sauts de ligne. NE TOUCHE PAS aux accents. */
  normalizeText(content) {
    return String(content ?? '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Parse un libelle de montant en nombre. Gere les formats FR ("10 000,50"),
   * EN ("10,000.50"), espaces fines, et entiers simples.
   * @param {string} raw
   * @returns {number|null}
   */
  parseAmount(raw) {
    if (raw == null) return null;
    let s = String(raw).replace(/[\s  ]/g, '');
    if (!s) return null;
    const hasComma = s.includes(',');
    const hasDot   = s.includes('.');
    if (hasComma && hasDot) {
      // Le dernier separateur rencontre est la decimale.
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
      else                                          s = s.replace(/,/g, '');
    } else if (hasComma) {
      // virgule : decimale si exactement 1-2 chiffres apres, sinon separateur de milliers
      const m = s.match(/^(.*),(\d{1,2})$/);
      if (m && !/,/.test(m[1])) s = `${m[1]}.${m[2]}`;
      else                       s = s.replace(/,/g, '');
    } else if (hasDot) {
      const m = s.match(/^(.*)\.(\d{1,2})$/);
      if (m && !/\./.test(m[1])) {
        // garde tel quel
      } else {
        s = s.replace(/\./g, '');
      }
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Extrait le montant principal (lié à un verbe transactionnel).
   * @param {string} content
   * @returns {number|null}
   */
  extractMainAmount(content) {
    const text = this.normalizeText(content);
    const m = text.match(RE_AMOUNT_BEFORE) ?? text.match(RE_AMOUNT_AFTER);
    return m ? this.parseAmount(m[1]) : null;
  }

  /**
   * Extrait le solde si present.
   * @param {string} content
   * @returns {number|null}
   */
  extractBalance(content) {
    const text = this.normalizeText(content);
    const m = text.match(RE_BAL_BEFORE) ?? text.match(RE_BAL_AFTER);
    return m ? this.parseAmount(m[1]) : null;
  }

  /**
   * Extrait un numero de telephone. Priorite au format international (+xxx).
   * Filtre les nombres qui sont en fait des montants/soldes/refs.
   * @param {string} content
   * @returns {string|null}
   */
  extractPhoneNumber(content) {
    const text = this.normalizeText(content);
    const amount  = this.extractMainAmount(text);
    const balance = this.extractBalance(text);
    const exclude = new Set([amount, balance].filter((v) => v != null).map(String));

    const matches = [...text.matchAll(RE_PHONE)].map((m) => m[1]);
    // Priorite : numero avec '+'
    const withPlus = matches.find((m) => m.startsWith('+'));
    if (withPlus) return withPlus;
    // Sinon premier nombre 9-12 chiffres qui n'est pas le montant/solde
    const plain = matches.find((m) => !m.startsWith('+') && !exclude.has(m.replace(/^\+/, '')));
    return plain ?? null;
  }

  /**
   * Extrait une reference (mots-cle ref/reference suivi d'un code alphanum).
   * @param {string} content
   * @returns {string|null}
   */
  extractReference(content) {
    const m = this.normalizeText(content).match(RE_REFERENCE);
    return m ? m[1] : null;
  }

  /**
   * Extrait un identifiant de transaction (transaction/tx/id suivi d'un code).
   * @param {string} content
   * @returns {string|null}
   */
  extractTransactionId(content) {
    const m = this.normalizeText(content).match(RE_TRANSACTION);
    return m ? m[1] : null;
  }

  /**
   * Detection du type de SMS. Verifie les categories transactionnelles d'abord,
   * puis bascule sur balance_check si seul un mot lie au solde est present.
   * @param {string} content
   * @returns {import('../types.js').SmsType}
   */
  detectSmsType(content) {
    const t = this.normalizeText(content).toLowerCase();
    // \b ne marche pas autour des accents en regex JS standard.
    // On utilise des lookaround Unicode-aware (\p{L}) pour eviter les faux-matchs mid-mot.
    if (/(?<![\p{L}])(?:re(?:c|ç)u|cr[eé]dit[eé]?)(?![\p{L}])/iu.test(t))      return 'money_received';
    if (/(?<![\p{L}])(?:envoy[eé]|d[eé]bit[eé]?|transfert)(?![\p{L}])/iu.test(t)) return 'money_sent';
    if (/(?<![\p{L}])(?:paiement|achat|pay[eé])(?![\p{L}])/iu.test(t))         return 'payment';
    if (/(?<![\p{L}])retrait(?![\p{L}])/iu.test(t) || /cash[\s\-]?out/i.test(t)) return 'cash_out';
    if (/(?<![\p{L}])d[eé]p[oô]t(?![\p{L}])/iu.test(t) || /cash[\s\-]?in/i.test(t)) return 'cash_in';
    if (/(?<![\p{L}])(?:solde|balance|disponible)(?![\p{L}])/iu.test(t))       return 'balance_check';
    return 'unknown';
  }

  /**
   * Devise detectee. Defaut : FCFA.
   * @param {string} content
   * @returns {string}
   */
  detectCurrency(content) {
    const m = this.normalizeText(content).match(RE_CURRENCY);
    return m ? m[1].toUpperCase() : 'FCFA';
  }

  /**
   * Score de confiance 0..1 base sur le nombre de champs extraits avec succes.
   * @param {Partial<import('../types.js').SmsAnalysisResult>} r
   * @returns {number}
   */
  calculateConfidence(r) {
    let c = 0;
    if (r.amount      != null) c += 0.30;
    if (r.balance     != null) c += 0.20;
    if (r.phoneNumber != null) c += 0.15;
    if (r.reference   != null) c += 0.10;
    if (r.transactionId != null) c += 0.05;
    if (r.smsType && r.smsType !== 'unknown') c += 0.20;
    return Math.round(Math.min(c, 1) * 100) / 100;
  }
}
