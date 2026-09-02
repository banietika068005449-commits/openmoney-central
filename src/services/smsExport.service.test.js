import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import {
  describeExportFilters,
  hasMeaningfulExportFilter,
  MAX_PNG_EXPORT_ROWS,
  makeExportFilename,
  normalizeReportRow,
  renderReportSvg,
  writeSmsPngExport,
} from './smsExport.service.js';

class MemoryResponse extends PassThrough {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  set(headers) {
    Object.assign(this.headers, headers);
    return this;
  }
}

function fakeRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    phone_number: index % 2 ? '061234567' : '051234567',
    received_at: '2026-09-02T13:30:00.000Z',
    amount: 5000 + index,
    duplicate_count: count,
    sms_note: index === 0 ? 'Verifier' : '',
    tecno: index === 1,
    status: index === 2 ? 'treated' : 'analyzed',
  }));
}

function fakeStreamFactory(rows) {
  return async function* stream() {
    yield { type: 'meta', total: rows.length };
    for (const row of rows) yield { type: 'row', row };
  };
}

async function collectExport(writer, rows) {
  const response = new MemoryResponse();
  const chunks = [];
  response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  await writer({
    filters: { q: '0612', sort: 'recent' },
    response,
    now: new Date('2026-09-02T13:30:00.000Z'),
    rowStreamFactory: fakeStreamFactory(rows),
  });
  return { response, body: Buffer.concat(chunks) };
}

test('export SMS: exige au moins un filtre metier', () => {
  assert.equal(hasMeaningfulExportFilter({ sort: 'recent', period: 'all' }), false);
  assert.equal(hasMeaningfulExportFilter({ q: '   ', sort: 'recent' }), false);
  assert.equal(hasMeaningfulExportFilter({ q: '06123', sort: 'recent' }), true);
  assert.equal(hasMeaningfulExportFilter({ hasNote: true }), true);
  assert.equal(hasMeaningfulExportFilter({ period: 'week' }), true);
});

test('export SMS: decrit les filtres avec le montant utilisateur', () => {
  const description = describeExportFilters({
    amount: 1_000_000,
    operatorPrefix: 'MTN',
    date: '2026-09-02',
    hour: 14,
    hasNote: true,
    sort: 'ancient',
  });
  assert.match(description, /Montant: 10\s?000/);
  assert.match(description, /Opérateur: MTN/);
  assert.match(description, /Jour: 2026-09-02/);
  assert.match(description, /Heure: 14:00/);
  assert.match(description, /Avec note/);
  assert.match(description, /plus anciens/);
});

test('export SMS: normalise une ligne comme la liste admin', () => {
  const row = normalizeReportRow({
    phone_number: '061234567',
    received_at: '2026-09-02T13:30:00.000Z',
    amount: '12500',
    duplicate_count: 2,
    sms_note: 'Verifier',
    tecno: true,
    status: 'treated',
  });
  assert.equal(row.tecno, 'OUI');
  assert.equal(row.phone, 'MTN  ·  061234567');
  assert.equal(row.duplicate, 'OUI');
  assert.equal(row.note, 'OUI');
  assert.equal(row.isTreated, true);
});

test('export SMS: produit des noms stables dans le fuseau metier', () => {
  const date = new Date('2026-09-02T13:30:00.000Z');
  assert.equal(makeExportFilename(date), 'openmoney-transactions-2026-09-02_14-30.png');
});

test('export SMS: echappe les valeurs dans les pages SVG', () => {
  const svg = renderReportSvg([{
    phone_number: '06<&123',
    received_at: '2026-09-02T13:30:00.000Z',
    amount: 5000,
  }], {
    total: 1,
    generatedAt: '02/09/2026 14:30',
    filters: 'Recherche: <test & contrôle>',
  });

  assert.match(svg, /06&lt;&amp;123/);
  assert.match(svg, /Recherche: &lt;test &amp; contrôle&gt;/);
  assert.doesNotMatch(svg, /<test & contrôle>/);
  assert.match(svg, /height="361"/);
});

test('export SMS: genere directement une image PNG unique', async () => {
  const { response, body } = await collectExport(writeSmsPngExport, fakeRows(22));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'image/png');
  assert.equal(response.headers['X-Export-Count'], '22');
  assert.match(response.headers['Content-Disposition'], /openmoney-transactions-2026-09-02_14-30\.png/);
  assert.deepEqual([...body.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(body.length > 1_000);
});

test('export SMS: accepte exactement 500 transactions dans une seule image', async () => {
  const { response, body } = await collectExport(writeSmsPngExport, fakeRows(MAX_PNG_EXPORT_ROWS));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['X-Export-Count'], String(MAX_PNG_EXPORT_ROWS));
  assert.deepEqual([...body.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('export SMS: refuse une image de plus de 500 transactions', async () => {
  await assert.rejects(
    () => collectExport(writeSmsPngExport, fakeRows(MAX_PNG_EXPORT_ROWS + 1)),
    (error) => {
      assert.equal(error.code, 'EXPORT_TOO_LARGE');
      assert.equal(error.status, 413);
      assert.deepEqual(error.details, {
        limit: MAX_PNG_EXPORT_ROWS,
        total: MAX_PNG_EXPORT_ROWS + 1,
      });
      return true;
    },
  );
});
