import { BaseSmsAnalyzer } from './base.js';

const RE_AIRTEL = /\bAirtel(?:\s*Money)?\b/i;

export class AirtelSmsAnalyzer extends BaseSmsAnalyzer {
  name = 'airtel-sms-analyzer';
  operator = 'AIRTEL';

  canAnalyze(sender, content) {
    return RE_AIRTEL.test(`${sender ?? ''} ${content ?? ''}`);
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
      extractedData: { sender, contentLength: content.length, matched: 'airtel' },
      analysisStatus: 'success',
      errorMessage: null,
    };
  }
}
