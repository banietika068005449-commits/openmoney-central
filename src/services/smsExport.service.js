import { ZipArchive } from 'archiver';
import PDFDocument from 'pdfkit';
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
const ROWS_PER_PAGE = 21;

const PDF = {
  margin: 32,
  tableY: 100,
  headerHeight: 24,
  rowHeight: 20,
  columns: [
    { key: 'tecno', label: 'TECNO', width: 65, align: 'center' },
    { key: 'date', label: 'DATE', width: 120 },
    { key: 'phone', label: 'NUMÉRO / OPÉRATEUR', width: 260 },
    { key: 'duplicate', label: 'DOUBLON', width: 100, align: 'center' },
    { key: 'note', label: 'NOTE', width: 80, align: 'center' },
    { key: 'amount', label: 'MONTANT', width: 153, align: 'right' },
  ],
};

const PNG = {
  width: 1600,
  height: 1131,
  margin: 60,
  tableY: 205,
  headerHeight: 44,
  rowHeight: 36,
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
  constructor(code, status) {
    super(code);
    this.name = 'SmsExportError';
    this.code = code;
    this.status = status;
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

export function makeExportFilename(kind, date = new Date()) {
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
  return kind === 'pdf'
    ? `openmoney-transactions-${stamp}.pdf`
    : `openmoney-transactions-${stamp}-png.zip`;
}

function reportMeta(filters, total, now = new Date()) {
  return {
    total,
    generatedAt: formatDate(now),
    filters: describeExportFilters(filters),
    totalPages: Math.max(1, Math.ceil(total / ROWS_PER_PAGE)),
  };
}

function drawPdfHeader(doc, meta, pageNumber) {
  const { margin, tableY, columns, headerHeight } = PDF;
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);

  doc.save().roundedRect(margin, 28, 30, 30, 5).fill(BRAND_BLUE);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(10).text('OM', margin, 38, {
    width: 30,
    align: 'center',
    lineBreak: false,
  }).restore();

  doc.fillColor(BRAND_BLUE).font('Helvetica-Bold').fontSize(17).text('OPEN', margin + 40, 31, { continued: true });
  doc.fillColor(BRAND_GREEN).text('MONEY');
  doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(13).text('TRANSACTIONS FILTRÉES', margin + 190, 34, {
    width: tableWidth - 190,
    align: 'right',
    lineBreak: false,
  });

  doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(meta.filters, margin, 68, {
    width: tableWidth,
    height: 12,
    ellipsis: true,
    lineBreak: false,
  });
  doc.font('Helvetica-Bold').fontSize(8).fillColor(TEXT).text(
    `${formatInteger(meta.total)} transaction(s)  ·  Généré le ${meta.generatedAt}`,
    margin,
    84,
    { width: tableWidth, lineBreak: false },
  );

  doc.rect(margin, tableY, tableWidth, headerHeight).fill(BRAND_BLUE);
  let x = margin;
  for (const column of columns) {
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7.5).text(
      column.label,
      x + 6,
      tableY + 8,
      {
        width: column.width - 12,
        align: column.align || 'left',
        lineBreak: false,
      },
    );
    x += column.width;
  }

  doc.fillColor(MUTED).font('Helvetica').fontSize(7).text(
    `OpenMoney  ·  Page ${pageNumber} / ${meta.totalPages}`,
    margin,
    doc.page.height - 19,
    { width: tableWidth, align: 'right', lineBreak: false },
  );
}

function drawPdfRow(doc, normalized, rowIndex) {
  const { margin, tableY, headerHeight, rowHeight, columns } = PDF;
  const y = tableY + headerHeight + rowIndex * rowHeight;
  const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
  const dark = normalized.isTecno;
  const background = dark ? BRAND_NAVY : (rowIndex % 2 ? ROW_ALT : '#FFFFFF');
  const foreground = dark ? '#FFFFFF' : TEXT;

  doc.rect(margin, y, tableWidth, rowHeight).fill(background);
  if (!dark && normalized.isTreated) {
    doc.rect(margin, y, 3, rowHeight).fill(BRAND_GREEN);
  }
  doc.moveTo(margin, y + rowHeight).lineTo(margin + tableWidth, y + rowHeight)
    .lineWidth(0.4).strokeColor(dark ? '#34349A' : BORDER).stroke();

  let x = margin;
  for (const column of columns) {
    doc.fillColor(foreground)
      .font(column.key === 'amount' ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(7.5)
      .text(normalized[column.key], x + 6, y + 6.5, {
        width: column.width - 12,
        height: rowHeight - 8,
        align: column.align || 'left',
        ellipsis: true,
        lineBreak: false,
      });
    x += column.width;
  }
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

export function renderReportSvg(rows, meta, pageNumber) {
  const { width, height, margin, tableY, headerHeight, rowHeight, columns } = PNG;
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
    text: `OpenMoney  ·  Page ${pageNumber} / ${meta.totalPages}`,
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
  return { iterator, total };
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new SmsExportError('EXPORT_ABORTED', 499);
}

export async function writeSmsPdfExport({
  filters,
  response,
  signal,
  now = new Date(),
  rowStreamFactory = streamSmsForExport,
}) {
  const { iterator, total } = await openExport(filters, rowStreamFactory);
  const meta = reportMeta(filters, total, now);
  const filename = makeExportFilename('pdf', now);
  let document;

  try {
    assertNotAborted(signal);
    response.status(200);
    response.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Export-Count': String(total),
    });

    document = new PDFDocument({
      autoFirstPage: false,
      bufferPages: false,
      compress: true,
      layout: 'landscape',
      margin: PDF.margin,
      size: 'A4',
      info: {
        Title: 'OpenMoney - Transactions filtrées',
        Author: 'OpenMoney',
        Subject: meta.filters,
      },
    });
    document.pipe(response);
    const outputFinished = finished(response, { cleanup: true });

    let index = 0;
    for await (const item of iterator) {
      if (item.type !== 'row') continue;
      assertNotAborted(signal);
      const rowIndex = index % ROWS_PER_PAGE;
      if (rowIndex === 0) {
        const pageNumber = Math.floor(index / ROWS_PER_PAGE) + 1;
        document.addPage();
        drawPdfHeader(document, meta, pageNumber);
      }
      drawPdfRow(document, normalizeReportRow(item.row), rowIndex);
      index += 1;
    }
    document.end();
    await outputFinished;
  } catch (error) {
    document?.destroy(error);
    await iterator.return?.();
    throw error;
  }
}

export async function writeSmsPngZipExport({
  filters,
  response,
  signal,
  now = new Date(),
  rowStreamFactory = streamSmsForExport,
}) {
  const { iterator, total } = await openExport(filters, rowStreamFactory);
  const meta = reportMeta(filters, total, now);
  const filename = makeExportFilename('png', now);
  const archive = new ZipArchive({ zlib: { level: 6 } });

  try {
    assertNotAborted(signal);
    response.status(200);
    response.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Export-Count': String(total),
    });
    archive.pipe(response);
    const outputFinished = finished(response, { cleanup: true });

    let pageRows = [];
    let pageNumber = 0;
    const appendPage = async () => {
      if (pageRows.length === 0) return;
      pageNumber += 1;
      const svg = renderReportSvg(pageRows, meta, pageNumber);
      const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
      archive.append(png, { name: `openmoney-transactions-page-${String(pageNumber).padStart(3, '0')}.png` });
      pageRows = [];
    };

    for await (const item of iterator) {
      if (item.type !== 'row') continue;
      assertNotAborted(signal);
      pageRows.push(item.row);
      if (pageRows.length === ROWS_PER_PAGE) await appendPage();
    }
    await appendPage();
    await archive.finalize();
    await outputFinished;
  } catch (error) {
    archive.abort();
    await iterator.return?.();
    throw error;
  }
}
