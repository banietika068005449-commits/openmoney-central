export function dedupeMessages(messages) {
  const seen = new Set();
  const out = [];
  for (const message of messages) {
    const key = [
      normalizeSender(message.numeroTel),
      normalizeTimestamp(message.smsRecuLe),
      normalizeContent(message.message),
    ].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(message);
  }
  return out;
}

export function normalizeSender(sender) {
  return String(sender ?? '').trim().replace(/\s+/g, '').toLowerCase();
}

export function normalizeContent(content) {
  return String(content ?? '').trim().replace(/\s+/g, ' ');
}

export function normalizeTimestamp(timestamp) {
  if (timestamp == null || timestamp === '') return '';
  const millis = Date.parse(timestamp);
  return Number.isNaN(millis) ? String(timestamp) : new Date(millis).toISOString();
}
