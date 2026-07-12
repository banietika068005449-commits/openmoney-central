// Construit un libelle de notification agent avec les VRAIES infos de la
// transaction (numero, montant, reference), a partir d'une ligne getSmsById.

function formatAmount(amount) {
  if (amount == null) return '';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(n) + ' FCFA';
}

/** Prefixe descriptif : "06xxxx – 25 000 FCFA (Ref ABC)". */
export function transactionLabel(sms) {
  if (!sms) return 'Transaction';
  const parts = [];
  if (sms.phone_number) parts.push(sms.phone_number);
  const amount = formatAmount(sms.amount);
  if (amount) parts.push(amount);
  let label = parts.join(' - ');
  const ref = sms.transaction_id || sms.reference;
  if (ref) label += ` (Ref ${ref})`;
  return label || `Transaction #${sms.id}`;
}

/** Message complet : "<prefixe> : <action>". */
export function transactionMessage(sms, action) {
  return `${transactionLabel(sms)} : ${action}`;
}
