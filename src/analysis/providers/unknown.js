import { BaseSmsAnalyzer } from './base.js';

// Fallback : essaie quand meme d'extraire des informations.
// Si rien d'utile -> analysisStatus = 'ignored'.
export class UnknownSmsAnalyzer extends BaseSmsAnalyzer {
  name = 'unknown-sms-analyzer';
  operator = null;

  canAnalyze(_sender, _content) { return true; }

  /** @returns {Promise<import('../types.js').SmsAnalysisResult>} */
  async analyze(sender, content) {
    const smsType       = this.detectSmsType(content);
    const amount        = this.extractMainAmount(content);
    const balance       = this.extractBalance(content);
    const currency      = this.detectCurrency(content);
    const phoneNumber   = this.extractPhoneNumber(content);
    const reference     = this.extractReference(content);
    const transactionId = this.extractTransactionId(content);

    const partial = { amount, balance, phoneNumber, reference, transactionId, smsType };
    let confidence = this.calculateConfidence(partial);
    // Fallback -> on borne la confiance plus bas que les providers specifiques
    confidence = Math.min(confidence, 0.6);

    const nothingFound =
      amount == null && balance == null && phoneNumber == null &&
      reference == null && transactionId == null && smsType === 'unknown';

    return {
      provider: this.name,
      operator: null,
      smsType,
      amount,
      balance,
      currency,
      phoneNumber,
      reference,
      transactionId,
      confidence,
      extractedData: { sender, contentLength: content.length, matched: 'fallback' },
      analysisStatus: nothingFound ? 'ignored' : 'success',
      errorMessage: null,
    };
  }
}
