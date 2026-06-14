// Registry des providers d'analyse SMS.
// Le premier provider dont canAnalyze() retourne true est selectionne.
// L'UnknownSmsAnalyzer doit etre place EN DERNIER (fallback catch-all).

export class SmsAnalyzerRegistry {
  /** @param {Array<{name:string, canAnalyze:(s:string,c:string)=>boolean, analyze:Function}>} providers */
  constructor(providers) {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new Error('SmsAnalyzerRegistry : liste de providers vide');
    }
    this.providers = providers;
  }

  /** @returns {Object|undefined} */
  pick(sender, content) {
    return this.providers.find((p) => p.canAnalyze(sender, content));
  }
}
