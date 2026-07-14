// Client HTTP du partenaire « Tecno Ya Niongo ».
//
// Endpoint : GET {BASE}/partner/devices  (header x-api-key)
// Renvoie UNIQUEMENT une liste de numeros de telephone (data.items).
//
// Regles de robustesse :
//   - cle API lue depuis l'env (jamais en dur, JAMAIS loggee) ;
//   - timeout via AbortController ;
//   - retries backoff+jitter sur reseau / 5xx uniquement ;
//   - 401 -> INVALID_KEY (pas de retry, alerte) ;
//   - 503 -> ACCESS_NOT_CONFIGURED (pas de retry, alerter l'editeur) ;
//   - autres 4xx -> CLIENT_ERROR (pas de retry, log + stop).

const DEFAULT_BASE_URL = 'https://api.tecno.ambitechdynamics.site';

export class TecnoPartnerError extends Error {
  /**
   * @param {string} code
   * @param {{ status?: number, retryable?: boolean, message?: string }} [opts]
   */
  constructor(code, { status = null, retryable = false, message } = {}) {
    super(message || code);
    this.name = 'TecnoPartnerError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function readConfig(overrides = {}) {
  return {
    apiKey: overrides.apiKey ?? process.env.TECNO_PARTNER_API_KEY ?? '',
    baseUrl: (overrides.baseUrl ?? process.env.TECNO_PARTNER_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    timeoutMs: Number(overrides.timeoutMs ?? process.env.TECNO_PARTNER_TIMEOUT_MS ?? 15000),
    maxRetries: Number(overrides.maxRetries ?? process.env.TECNO_PARTNER_MAX_RETRIES ?? 3),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Delai backoff exponentiel + jitter pour la tentative n (0-based). */
function backoffDelay(attempt) {
  const base = 500 * 2 ** attempt; // 500ms, 1s, 2s...
  return base + Math.floor(Math.random() * 250);
}

/**
 * Recupere une page de numeros. Ne fait PAS la pagination (cf. tecnoSync.service.js).
 *
 * @param {{ take?: number, skip?: number, imei?: string, updatedSince?: string }} params
 * @param {{ apiKey?: string, baseUrl?: string, timeoutMs?: number, maxRetries?: number, fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<{ items: string[], itemCount: number, totalDevices: number, take: number, skip: number }>}
 */
export async function fetchDevicesPage(params = {}, deps = {}) {
  const cfg = readConfig(deps);
  const fetchImpl = deps.fetchImpl || fetch;

  if (!cfg.apiKey) {
    throw new TecnoPartnerError('NO_API_KEY', { message: 'TECNO_PARTNER_API_KEY manquant' });
  }

  const take = Math.min(Math.max(Number(params.take) || 50, 1), 200);
  const query = new URLSearchParams({ take: String(take), skip: String(Number(params.skip) || 0) });
  if (params.imei) query.set('imei', String(params.imei));
  if (params.updatedSince) query.set('updatedSince', String(params.updatedSince));
  const url = `${cfg.baseUrl}/partner/devices?${query}`;

  let lastErr;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { 'x-api-key': cfg.apiKey, Accept: 'application/json' },
        signal: controller.signal,
      });

      if (res.status === 200) {
        const payload = await res.json().catch(() => null);
        const data = payload?.data;
        if (!data || !Array.isArray(data.items)) {
          throw new TecnoPartnerError('BAD_RESPONSE', { status: 200, message: 'Reponse sans data.items' });
        }
        return {
          items: data.items.map(String),
          itemCount: Number(data.itemCount ?? data.items.length),
          totalDevices: Number(data.totalDevices ?? 0),
          take: Number(data.take ?? take),
          skip: Number(data.skip ?? (Number(params.skip) || 0)),
        };
      }

      if (res.status === 401) {
        throw new TecnoPartnerError('INVALID_KEY', { status: 401, retryable: false });
      }
      if (res.status === 503) {
        throw new TecnoPartnerError('ACCESS_NOT_CONFIGURED', { status: 503, retryable: false });
      }
      if (res.status >= 400 && res.status < 500) {
        throw new TecnoPartnerError('CLIENT_ERROR', { status: res.status, retryable: false });
      }
      // 5xx -> retryable
      lastErr = new TecnoPartnerError('SERVER_ERROR', { status: res.status, retryable: true });
    } catch (e) {
      if (e instanceof TecnoPartnerError) {
        if (!e.retryable) throw e; // 401/503/4xx/BAD_RESPONSE : stop immediat
        lastErr = e;
      } else {
        // Erreur reseau / timeout (AbortError) -> retryable
        lastErr = new TecnoPartnerError('NETWORK_ERROR', { retryable: true, message: e.message });
      }
    } finally {
      clearTimeout(timer);
    }

    if (attempt < cfg.maxRetries) await sleep(backoffDelay(attempt));
  }

  throw lastErr;
}
