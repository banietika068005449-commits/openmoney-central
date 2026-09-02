import sharp from 'sharp';
import { finished } from 'node:stream/promises';
import { streamSmsForExport } from '../repos/sms.repo.js';

const BRAND_BLUE = '#1B2D5C';
const BRAND_GREEN = '#22C55E';
const BRAND_NAVY = '#191970';
const TEXT = '#172033';
const MUTED = '#64748B';
const BORDER = '#D8E1EC';
const ROW_ALT = '#F8FAFC';
export const MAX_PNG_EXPORT_ROWS = 500;

const PNG = {
  width: 1600,
  margin: 60,
  tableY: 205,
  headerHeight: 44,
  rowHeight: 36,
  footerHeight: 76,
  columns: [
    { key: 'tecno', label: 'TECNO', width: 110, align: 'center' },
    { key: 'date', label: 'DATE', width: 220 },
    { key: 'phone', label: 'NUMÉRO / OPÉRATEUR', width: 480 },
    { key: 'duplicate', label: 'DOUBLON', width: 180, align: 'center' },
    { key: 'note', label: 'NOTE', width: 150, align: 'center' },
    { key: 'amount', label: 'MONTANT', width: 340, align: 'right' },
  ],
};

const FILTER_KEYS = [
  'status', 'smsType', 'operator', 'operatorPrefix', 'phone', 'transactionId',
  'hasNote', 'tecno', 'amount', 'q', 'date', 'hour',
];

export class SmsExportError extends Error {
  constructor(code, status, details = {}) {
    super(code);
    this.name = 'SmsExportError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function hasMeaningfulExportFilter(filters = {}) {
  return FILTER_KEYS.some((key) => {
    const value = filters[key];
    if (typeof value === 'string') return value.trim() !== '';
    return value !== undefined && value !== null && value !== false;
  }) || Boolean(filters.period && filters.period !== 'all');
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Africa/Brazzaville',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatAmount(value) {
  if (value === null || value === undefined || value === '') return '-';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '-';
  return new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 2,
  }).format(amount).replace(/[\u00A0\u202F]/g, ' ');
}

function formatInteger(value) {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })
    .format(Number(value) || 0)
    .replace(/[\u00A0\u202F]/g, ' ');
}

function operatorForPhone(phone) {
  const normalized = String(phone || '').replace(/\D/g, '');
  if (normalized.startsWith('06')) return 'MTN';
  if (normalized.startsWith('05') || normalized.startsWith('04')) return 'AIRTEL';
  return '';
}

export function normalizeReportRow(row = {}) {
  const analyzedPhone = String(row.phone_number || '').trim();
  const phone = analyzedPhone || '-';
  const operator = analyzedPhone
    ? (operatorForPhone(analyzedPhone) || String(row.analysis_operator || '').trim())
    : '';
  return {
    tecno: row.tecno ? 'OUI' : '-',
    date: formatDate(row.received_at),
    phone: operator ? `${operator}  ·  ${phone}` : phone,
    duplicate: analyzedPhone && Number(row.duplicate_count || 0) > 1 ? 'OUI' : '-',
    note: String(row.sms_note || '').trim() ? 'OUI' : '-',
    amount: formatAmount(row.amount),
    isTecno: Boolean(row.tecno),
    isTreated: row.status === 'treated',
  };
}

export function describeExportFilters(filters = {}) {
  const labels = [];
  if (filters.q) labels.push(`Recherche: ${filters.q}`);
  if (filters.amount) labels.push(`Montant: ${formatAmount(Number(filters.amount) / 100)}`);
  if (filters.operatorPrefix) labels.push(`Opérateur: ${filters.operatorPrefix}`);
  else if (filters.operator) labels.push(`Opérateur: ${filters.operator}`);
  if (filters.status) labels.push(`Copie: ${filters.status === 'treated' ? 'copies' : filters.status}`);
  if (filters.phone) labels.push(`Numéro: ${filters.phone}`);
  if (filters.transactionId) labels.push(`Transaction reunie: ${filters.transactionId}`);
  if (filters.date) labels.push(`Jour: ${filters.date}`);
  if (Number.isInteger(filters.hour)) labels.push(`Heure: ${String(filters.hour).padStart(2, '0')}:00`);
  if (filters.hasNote) labels.push('Avec note');
  if (filters.tecno === 'only') labels.push('TECNO uniquement');
  if (filters.tecno === 'hide') labels.push('TECNO masqués');
  if (filters.smsType) labels.push(`Type: ${filters.smsType}`);
  if (filters.period === 'days') labels.push('Periode: 24 heures');
  if (filters.period === 'week') labels.push('Periode: 7 jours');
  labels.push(`Tri: ${filters.sort === 'ancient' ? 'plus anciens' : 'plus récents'}`);
  return labels.join('  |  ');
}

export function makeExportFilename(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Brazzaville',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  const stamp = `${get('year')}-${get('month')}-${get('day')}_${get('hour')}-${get('minute')}`;
  return `openmoney-transactions-${stamp}.png`;
}

function reportMeta(filters, total, now = new Date()) {
  return {
    total,
    generatedAt: formatDate(now),
    filters: describeExportFilters(filters),
  };
}

function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function svgText({ x, y, text, size = 18, weight = 400, fill = TEXT, anchor = 'start' }) {
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="Inter,Arial,DejaVu Sans,sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" dominant-baseline="middle">${xml(text)}</text>`;
}

export function renderReportSvg(rows, meta) {
  const { width, margin, tableY, headerHeight, rowHeight, footerHeight, columns } = PNG;
  const height = tableY + headerHeight + rows.length * rowHeight + footerHeight;
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
  const elements = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#FFFFFF"/>',
    `<rect x="${margin}" y="48" width="58" height="58" rx="10" fill="${BRAND_BLUE}"/>`,
    svgText({ x: margin + 29, y: 78, text: 'OM', size: 19, weight: 800, fill: '#FFFFFF', anchor: 'middle' }),
    svgText({ x: margin + 78, y: 67, text: 'OPEN', size: 31, weight: 800, fill: BRAND_BLUE }),
    svgText({ x: margin + 168, y: 67, text: 'MONEY', size: 31, weight: 800, fill: BRAND_GREEN }),
    svgText({ x: width - margin, y: 72, text: 'TRANSACTIONS FILTRÉES', size: 24, weight: 800, anchor: 'end' }),
    svgText({ x: margin, y: 132, text: truncate(meta.filters, 150), size: 15, fill: MUTED }),
    svgText({
      x: margin,
      y: 164,
      text: `${formatInteger(meta.total)} transaction(s)  ·  Généré le ${meta.generatedAt}`,
      size: 16,
      weight: 700,
    }),
    `<rect x="${margin}" y="${tableY}" width="${tableWidth}" height="${headerHeight}" fill="${BRAND_BLUE}"/>`,
  ];

  let headerX = margin;
  for (const column of columns) {
    const anchor = column.align === 'right' ? 'end' : column.align === 'center' ? 'middle' : 'start';
    const x = column.align === 'right'
      ? headerX + column.width - 14
      : column.align === 'center'
        ? headerX + column.width / 2
        : headerX + 14;
    elements.push(svgText({
      x,
      y: tableY + headerHeight / 2 + 1,
      text: column.label,
      size: 15,
      weight: 800,
      fill: '#FFFFFF',
      anchor,
    }));
    headerX += column.width;
  }

  rows.forEach((row, rowIndex) => {
    const normalized = normalizeReportRow(row);
    const y = tableY + headerHeight + rowIndex * rowHeight;
    const dark = normalized.isTecno;
    elements.push(`<rect x="${margin}" y="${y}" width="${tableWidth}" height="${rowHeight}" fill="${dark ? BRAND_NAVY : (rowIndex % 2 ? ROW_ALT : '#FFFFFF')}"/>`);
    if (!dark && normalized.isTreated) {
      elements.push(`<rect x="${margin}" y="${y}" width="6" height="${rowHeight}" fill="${BRAND_GREEN}"/>`);
    }
    elements.push(`<line x1="${margin}" y1="${y + rowHeight}" x2="${margin + tableWidth}" y2="${y + rowHeight}" stroke="${dark ? '#34349A' : BORDER}" stroke-width="1"/>`);

    let xOffset = margin;
    for (const column of columns) {
      const anchor = column.align === 'right' ? 'end' : column.align === 'center' ? 'middle' : 'start';
      const textX = column.align === 'right'
        ? xOffset + column.width - 14
        : column.align === 'center'
          ? xOffset + column.width / 2
          : xOffset + 14;
      const maxLength = column.key === 'phone' ? 40 : column.key === 'date' ? 22 : 18;
      elements.push(svgText({
        x: textX,
        y: y + rowHeight / 2 + 1,
        text: truncate(normalized[column.key], maxLength),
        size: 15,
        weight: column.key === 'amount' ? 700 : 400,
        fill: dark ? '#FFFFFF' : TEXT,
        anchor,
      }));
      xOffset += column.width;
    }
  });

  elements.push(svgText({
    x: width - margin,
    y: height - 34,
    text: `OpenMoney  ·  ${formatInteger(meta.total)} transaction(s)`,
    size: 14,
    fill: MUTED,
    anchor: 'end',
  }));
  elements.push('</svg>');
  return elements.join('');
}

async function openExport(filters, rowStreamFactory) {
  if (!hasMeaningfulExportFilter(filters)) {
    throw new SmsExportError('EXPORT_FILTER_REQUIRED', 400);
  }
  const iterator = rowStreamFactory(filters);
  const first = await iterator.next();
  const total = first.value?.type === 'meta' ? first.value.total : 0;
  if (!total) {
    await iterator.return?.();
    throw new SmsExportError('NO_TRANSACTIONS_TO_EXPORT', 404);
  }
  if (total > MAX_PNG_EXPORT_ROWS) {
    await iterator.return?.();
    throw new SmsExportError('EXPORT_TOO_LARGE', 413, {
      limit: MAX_PNG_EXPORT_ROWS,
      total,
    });
  }
  return { iterator, total };
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new SmsExportError('EXPORT_ABORTED', 499);
}

export async function writeSmsPngExport({
  filters,
  response,
  signal,
  now = new Date(),
  rowStreamFactory = streamSmsForExport,
}) {
  const { iterator, total } = await openExport(filters, rowStreamFactory);
  const meta = reportMeta(filters, total, now);
  const filename = makeExportFilename(now);

  try {
    assertNotAborted(signal);
    const rows = [];
    for await (const item of iterator) {
      if (item.type !== 'row') continue;
      assertNotAborted(signal);
      rows.push(item.row);
    }

    const svg = renderReportSvg(rows, meta);
    const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
    assertNotAborted(signal);

    response.status(200);
    response.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(png.length),
      'Cache-Control': 'no-store',
      'X-Export-Count': String(total),
    });
    const outputFinished = finished(response, { cleanup: true });
    response.end(png);
    await outputFinished;
  } catch (error) {
    await iterator.return?.();
    throw error;
  }
}
