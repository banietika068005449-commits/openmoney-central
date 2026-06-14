import { BaseSmsAnalyzer } from './base.js';

const RE_MTN = /\bMTN\b|\bMoMo\b|Mobile\s*Money/i;

export class MtnSmsAnalyzer extends BaseSmsAnalyzer {
  name = 'mtn-sms-analyzer';
  operator = 'MTN';

  canAnalyze(sender, content) {
    return RE_MTN.test(`${sender ?? ''} ${content ?? ''}`);
  }

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
    const confidence = this.calculateConfidence(partial);

    return {
      provider: this.name,
      operator: this.operator,
      smsType,
      amount,
      balance,
      currency,
      phoneNumber,
      reference,
      transactionId,
      confidence,
      extractedData: { sender, contentLength: content.length, matched: 'mtn' },
      analysisStatus: 'success',
      errorMessage: null,
    };
  }
}
