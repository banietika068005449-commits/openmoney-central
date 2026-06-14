import { BaseSmsAnalyzer } from './base.js';

// Mots-cles marketing/promo : si on en trouve UN dans le SMS, on classe en
// `ignored` immediatement, sans frapper le LLM (economie de tokens).
// Liste deliberement courte et conservatrice pour eviter les faux positifs
// sur de vrais SMS de transaction (qui peuvent mentionner "frais", "solde", etc.)
const PROMO_KEYWORDS = [
  'promo', 'promotion', 'promotionnel',
  'bonus',
  'cadeau',
  'gagn',                    // gagne, gagner, gagnez
  'abonn',                   // abonnement, abonner
  'forfait',
  'tarif',
  'rechargement', 'rechargez', 'recharger',
  'gratuit',
  'cliquez', 'cliquer',
  'offre speciale', 'offre limitee', 'duree limitee',
  'jackpot',
];

/**
 * Filtre marketing en tete de chaine d'analyse.
 *
 * Si le contenu contient un mot-cle promo, on retourne `analysisStatus: 'ignored'`
 * sans toucher au LLM. Sinon canAnalyze=false et la chaine continue (MTN regex,
 * Airtel regex, AI, Unknown).
 */
export class PromoSmsAnalyzer extends BaseSmsAnalyzer {
  name = 'promo-filter';
  operator = null;

  canAnalyze(_sender, content) {
    if (!content || typeof content !== 'string') return false;
    const lc = content.toLowerCase();
    return PROMO_KEYWORDS.some((k) => lc.includes(k));
  }

  async analyze(_sender, content) {
    return {
      provider: this.name,
      operator: null,
      smsType: 'notification',
      amount: null,
      balance: null,
      currency: null,
      phoneNumber: null,
      reference: null,
      transactionId: null,
      confidence: 1.0,
      extractedData: {
        reason: 'promo-keyword',
        contentLength: content?.length ?? 0,
      },
      analysisStatus: 'ignored',
      errorMessage: null,
    };
  }
}
