const CANONICAL_PHONE = /^\+242(04|05|06)\d{7}$/;

export function normalizeCongoPhone(value) {
  if (typeof value !== 'string') return null;
  let phone = value.trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('00242')) phone = `+${phone.slice(2)}`;
  else if (phone.startsWith('242')) phone = `+${phone}`;
  else if (/^0[456]/.test(phone)) phone = `+242${phone}`;
  if (!CANONICAL_PHONE.test(phone)) return null;
  return phone;
}

export { CANONICAL_PHONE };
