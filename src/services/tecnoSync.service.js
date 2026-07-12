// Service de synchronisation des numeros TECNO depuis « Tecno Ya Niongo ».
//
// - mode 'full'        : parcourt tous les appareils (init / resync quotidien).
// - mode 'incremental' : ne recupere que les appareils modifies depuis la
//                        derniere execution reussie (updatedSince = lastCursor).
//
// Pagination sur les APPAREILS (totalDevices), pas sur les numeros. Les numeros
// peuvent se repeter -> dedup via Set, puis UPSERT idempotent (repo).

import { fetchDevicesPage, TecnoPartnerError } from './tecnoPartner.client.js';
import { upsertPartnerTecnoNumbers } from '../repos/sms.repo.js';
import { getTecnoSyncState, setTecnoSyncState } from '../repos/setting.repo.js';

const PAGE_SIZE = 200;      // take max autorise
const MAX_PAGES = 1000;     // garde-fou anti-boucle infinie (200k appareils)

// Verrou anti-chevauchement : un seul sync a la fois (cron + declenchement manuel).
let syncInFlight = false;

/**
 * Lance une synchronisation.
 * @param {{ mode?: 'full'|'incremental' }} [opts]
 * @returns {Promise<{ mode:'full'|'incremental', upserted:number, totalDevices:number, pages:number, uniqueNumbers:number }>}
 */
export async function syncTecnoNumbers({ mode = 'incremental' } = {}) {
  if (syncInFlight) {
    throw new TecnoPartnerError('SYNC_IN_PROGRESS', { message: 'Une synchronisation est deja en cours' });
  }
  syncInFlight = true;

  const runStartedAt = new Date();
  const state = await getTecnoSyncState();

  // Sans curseur connu, un incremental n'a pas de point de depart -> full.
  let effectiveMode = mode;
  let updatedSince;
  if (effectiveMode === 'incremental') {
    if (state.lastCursor) updatedSince = state.lastCursor;
    else effectiveMode = 'full';
  }

  await setTecnoSyncState({ lastRunAt: runStartedAt.toISOString() });

  try {
    const seen = new Set();
    let upserted = 0;
    let totalDevices = 0;
    let devicesSeen = 0;
    let pages = 0;

    for (let skip = 0; pages < MAX_PAGES; skip += PAGE_SIZE) {
      const page = await fetchDevicesPage({ take: PAGE_SIZE, skip, updatedSince });
      pages += 1;
      totalDevices = page.totalDevices;

      const fresh = [];
      for (const num of page.items) {
        if (!seen.has(num)) { seen.add(num); fresh.push(num); }
      }
      // UPSERT par page pour limiter la memoire ; idempotent.
      if (fresh.length) {
        const { upserted: n } = await upsertPartnerTecnoNumbers(fresh);
        upserted += n;
      }

      // Progression basee sur les APPAREILS. On avance de PAGE_SIZE appareils par page.
      devicesSeen += PAGE_SIZE;
      // Arret : plus d'appareils a parcourir, ou page vide (defensif).
      if (page.items.length === 0 || devicesSeen >= totalDevices) break;
    }

    // Le curseur du prochain incremental = debut de CETTE execution reussie.
    await setTecnoSyncState({
      lastSuccessAt: new Date().toISOString(),
      lastCursor: runStartedAt.toISOString(),
      lastStatus: 'ok',
      lastError: null,
      lastUpserted: upserted,
      totalDevices,
    });

    console.log(`[tecno-sync] ${effectiveMode} ok : ${seen.size} numeros uniques, ${upserted} upsert, ${totalDevices} appareils, ${pages} page(s)`);
    return { mode: effectiveMode, upserted, totalDevices, pages, uniqueNumbers: seen.size };
  } catch (err) {
    const code = err instanceof TecnoPartnerError ? err.code : 'UNKNOWN';
    // Alerte : 401 (cle invalide) et 503 (acces non configure cote Tecno) sont
    // des conditions a signaler a l'editeur. On NE fait PAS avancer lastCursor.
    if (code === 'INVALID_KEY') {
      console.error('[tecno-sync] ALERTE : cle API partenaire invalide (401). Verifier TECNO_PARTNER_API_KEY.');
    } else if (code === 'ACCESS_NOT_CONFIGURED') {
      console.error('[tecno-sync] ALERTE : acces partenaire non configure cote Tecno (503). Contacter l\'editeur Tecno Ya Niongo.');
    } else {
      console.error(`[tecno-sync] echec (${code}) :`, err.message);
    }
    await setTecnoSyncState({ lastStatus: 'error', lastError: code });
    throw err;
  } finally {
    syncInFlight = false;
  }
}

export function isSyncInFlight() {
  return syncInFlight;
}
