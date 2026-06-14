/**
 * Typedefs JSDoc pour le moteur d'analyse SMS.
 * Pas de runtime — l'IDE et `tsc --checkJs` les consomment.
 *
 * @typedef {'success'|'failed'|'ignored'} SmsAnalysisStatus
 *
 * @typedef {(
 *   'money_received' | 'money_sent' | 'payment' |
 *   'cash_out' | 'cash_in' | 'balance_check' |
 *   'notification' | 'unknown'
 * )} SmsType
 *
 * @typedef {Object} SmsAnalysisResult
 * @property {string} provider
 * @property {string|null} [operator]
 * @property {SmsType} smsType
 * @property {number|null} [amount]
 * @property {number|null} [balance]
 * @property {string|null} [currency]
 * @property {string|null} [phoneNumber]
 * @property {string|null} [reference]
 * @property {string|null} [transactionId]
 * @property {number} confidence                  // 0..1
 * @property {Record<string,any>} extractedData
 * @property {SmsAnalysisStatus} analysisStatus
 * @property {string|null} [errorMessage]
 */
export {};
