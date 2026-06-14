import { BaseSmsAnalyzer } from './base.js';
import { pickRandomActiveProviderKey, bumpKeyUsage } from '../../db.js';
import { getSystemPrompt as fetchSystemPrompt } from '../../repos/setting.repo.js';

// AiSmsAnalyzer : fallback intelligent qui appelle un LLM (OpenAI/Anthropic/Google/Mistral).
// Une cle est tiree aleatoirement parmi les couples (provider, key) actifs.
//
// canAnalyze : utilise un flag cache (rafraichi par refresh()) pour eviter de
// hit la DB a chaque SMS. L'index.js declenche un refresh periodique.

// Prompt systeme par defaut. Surcharge globale possible via parametre.system_prompt
// (un seul prompt pour TOUS les providers LLM, edite depuis le dashboard).
export const DEFAULT_SYSTEM_PROMPT = `Tu analyses des SMS bancaires/mobile money africains. Tu reponds UNIQUEMENT par un JSON valide, sans markdown, avec les champs :
- smsType : un parmi "money_received"|"money_sent"|"payment"|"cash_out"|"cash_in"|"balance_check"|"notification"|"unknown"
- amount : montant principal en chiffres (number) ou null
- balance : solde du compte (number) ou null
- currency : "FCFA"|"XAF"|"XOF"|"EUR"|"USD" ou null
- phoneNumber : numero de telephone evoque (string, garder le + si present) ou null
- reference : reference de transaction (string) ou null
- transactionId : identifiant de transaction (string) ou null
- operator : "MTN"|"AIRTEL"|"ORANGE"|"MOOV"|... ou null
- confidence : nombre entre 0 et 1

Ne pas inventer. Si une valeur n'est pas presente : null.`;

const PROMPT_USER = (sender, content) => `Analyse ce SMS :

SMS sender : ${JSON.stringify(sender)}
SMS content : ${JSON.stringify(content)}`;

export class AiSmsAnalyzer extends BaseSmsAnalyzer {
  name = 'ai-sms-analyzer';
  operator = null;
  /** @type {boolean} flag cache : vrai si au moins un (provider, key) actif existe */
  hasActiveKey = false;
  /** @type {string} prompt systeme global cache, rafraichi avec refresh() */
  systemPrompt = DEFAULT_SYSTEM_PROMPT;

  constructor({ logger = console } = {}) {
    super();
    this.logger = logger;
  }

  canAnalyze(_sender, _content) { return this.hasActiveKey; }

  /** Met a jour le flag canAnalyze + le prompt systeme global. */
  async refresh() {
    try {
      const row = await pickRandomActiveProviderKey();
      this.hasActiveKey = !!row;
      const custom = await fetchSystemPrompt();
      this.systemPrompt = (custom && custom.trim()) ? custom : DEFAULT_SYSTEM_PROMPT;
    } catch (err) {
      this.logger.warn?.(`[ai-analyzer] refresh : ${err.message}`);
      this.hasActiveKey = false;
    }
  }

  /** @returns {Promise<import('../types.js').SmsAnalysisResult>} */
  async analyze(sender, content) {
    const cfg = await pickRandomActiveProviderKey();
    if (!cfg) {
      // Aucune cle configuree (race condition apres refresh()) -> fallback regex-only
      return this._regexFallback(sender, content, 'no-key');
    }

    try {
      const raw = await this._callLlm(cfg, sender, content);
      const parsed = this._parseLlmJson(raw);
      await bumpKeyUsage(cfg.key_id);
      return this._buildResult(cfg, parsed, sender, content);
    } catch (err) {
      this.logger.warn?.(`[ai-analyzer] echec ${cfg.provider_type}/${cfg.model} : ${err.message}`);
      return this._regexFallback(sender, content, `llm-error:${err.message}`);
    }
  }

  // --- internals ---

  /** Fallback : utilise les regex de base si l'AI n'est pas dispo. */
  _regexFallback(sender, content, reason) {
    const smsType = this.detectSmsType(content);
    const amount = this.extractMainAmount(content);
    const balance = this.extractBalance(content);
    const currency = this.detectCurrency(content);
    const phoneNumber = this.extractPhoneNumber(content);
    const reference = this.extractReference(content);
    const transactionId = this.extractTransactionId(content);
    const partial = { amount, balance, phoneNumber, reference, transactionId, smsType };
    return {
      provider: this.name,
      operator: null,
      smsType, amount, balance, currency, phoneNumber, reference, transactionId,
      confidence: Math.min(this.calculateConfidence(partial), 0.5),
      extractedData: { sender, contentLength: content.length, fallback: reason },
      analysisStatus: smsType === 'unknown' && amount == null && balance == null ? 'ignored' : 'success',
      errorMessage: null,
    };
  }

  /** Appelle le LLM selon le provider_type. Utilise le systemPrompt global cache. */
  async _callLlm({ provider_type, model, base_url, api_key }, sender, content) {
    const systemPrompt = this.systemPrompt;
    const userMsg = PROMPT_USER(sender, content);

    switch (provider_type) {
      case 'openai':
      case 'mistral':
      case 'custom': {
        const url = base_url || (provider_type === 'mistral'
          ? 'https://api.mistral.ai/v1/chat/completions'
          : 'https://api.openai.com/v1/chat/completions');
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api_key}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
            response_format: { type: 'json_object' },
            temperature: 0,
          }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text().catch(() => '')}`.slice(0, 300));
        const j = await r.json();
        return j.choices?.[0]?.message?.content ?? '';
      }

      case 'anthropic': {
        const url = base_url || 'https://api.anthropic.com/v1/messages';
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': api_key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMsg }],
          }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text().catch(() => '')}`.slice(0, 300));
        const j = await r.json();
        return j.content?.[0]?.text ?? '';
      }

      case 'google': {
        const url = base_url
          || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(api_key)}`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userMsg }] }],
            generationConfig: { temperature: 0, responseMimeType: 'application/json' },
          }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text().catch(() => '')}`.slice(0, 300));
        const j = await r.json();
        return j.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      }

      default:
        throw new Error(`provider_type non supporte : ${provider_type}`);
    }
  }

  /** Extrait le JSON d'une reponse LLM (tolere markdown autour). */
  _parseLlmJson(raw) {
    if (!raw) throw new Error('reponse LLM vide');
    // Strip code fences si presents
    let s = String(raw).trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    // Si du texte autour, tente d'extraire la 1ere accolade jusqu'a la derniere
    if (!s.startsWith('{')) {
      const i = s.indexOf('{');
      const j = s.lastIndexOf('}');
      if (i >= 0 && j > i) s = s.slice(i, j + 1);
    }
    return JSON.parse(s);
  }

  /** Construit un SmsAnalysisResult typed a partir du JSON LLM. */
  _buildResult(cfg, j, sender, content) {
    const num = (v) => (v == null || v === '' ? null : Number(v));
    const str = (v) => (v == null || v === '' ? null : String(v));
    /** @type {import('../types.js').SmsAnalysisResult} */
    const r = {
      provider: this.name,
      operator: str(j.operator),
      smsType: this._coerceType(j.smsType),
      amount: Number.isFinite(num(j.amount)) ? num(j.amount) : null,
      balance: Number.isFinite(num(j.balance)) ? num(j.balance) : null,
      currency: str(j.currency) || 'FCFA',
      phoneNumber: str(j.phoneNumber),
      reference: str(j.reference),
      transactionId: str(j.transactionId),
      confidence: Math.max(0, Math.min(1, num(j.confidence) ?? 0.5)),
      extractedData: {
        sender,
        contentLength: content.length,
        ai: { providerType: cfg.provider_type, model: cfg.model, keyLabel: cfg.label ?? null },
        llmJson: j,
      },
      analysisStatus: 'success',
      errorMessage: null,
    };
    if (r.smsType === 'unknown' && r.amount == null && r.balance == null) r.analysisStatus = 'ignored';
    return r;
  }

  _coerceType(t) {
    const allowed = ['money_received','money_sent','payment','cash_out','cash_in','balance_check','notification','unknown'];
    return allowed.includes(t) ? t : 'unknown';
  }
}
