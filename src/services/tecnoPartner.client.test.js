import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { fetchDevicesPage, TecnoPartnerError } from './tecnoPartner.client.js';

const DEPS = { apiKey: 'k', baseUrl: 'https://example.test', timeoutMs: 1000, maxRetries: 2 };

function res(status, payload) {
  return async () => ({ status, json: async () => payload });
}

test('fetchDevicesPage: 200 -> renvoie data.items normalises', async () => {
  const page = await fetchDevicesPage(
    { take: 200, skip: 0 },
    { ...DEPS, fetchImpl: res(200, { data: { items: ['069507034', '055898959'], itemCount: 2, totalDevices: 5, take: 200, skip: 0 } }) },
  );
  assert.deepEqual(page.items, ['069507034', '055898959']);
  assert.equal(page.totalDevices, 5);
});

test('fetchDevicesPage: cle absente -> NO_API_KEY', async () => {
  await assert.rejects(
    () => fetchDevicesPage({}, { ...DEPS, apiKey: '', fetchImpl: res(200, {}) }),
    (e) => e instanceof TecnoPartnerError && e.code === 'NO_API_KEY',
  );
});

test('fetchDevicesPage: 401 -> INVALID_KEY non-retryable (une seule tentative)', async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchDevicesPage({}, { ...DEPS, fetchImpl: async () => { calls += 1; return { status: 401, json: async () => ({}) }; } }),
    (e) => e instanceof TecnoPartnerError && e.code === 'INVALID_KEY' && e.retryable === false,
  );
  assert.equal(calls, 1);
});

test('fetchDevicesPage: 503 -> ACCESS_NOT_CONFIGURED non-retryable', async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchDevicesPage({}, { ...DEPS, fetchImpl: async () => { calls += 1; return { status: 503, json: async () => ({}) }; } }),
    (e) => e instanceof TecnoPartnerError && e.code === 'ACCESS_NOT_CONFIGURED',
  );
  assert.equal(calls, 1);
});

test('fetchDevicesPage: autre 4xx -> CLIENT_ERROR non-retryable', async () => {
  await assert.rejects(
    () => fetchDevicesPage({}, { ...DEPS, fetchImpl: res(422, {}) }),
    (e) => e instanceof TecnoPartnerError && e.code === 'CLIENT_ERROR' && e.status === 422,
  );
});

test('fetchDevicesPage: 500 puis 200 -> retry reussi', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { status: 500, json: async () => ({}) };
    return { status: 200, json: async () => ({ data: { items: ['069507034'], itemCount: 1, totalDevices: 1, take: 200, skip: 0 } }) };
  };
  const page = await fetchDevicesPage({}, { ...DEPS, maxRetries: 2, fetchImpl });
  assert.equal(calls, 2);
  assert.deepEqual(page.items, ['069507034']);
});

test('fetchDevicesPage: 500 persistant -> SERVER_ERROR apres maxRetries', async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchDevicesPage({}, { ...DEPS, maxRetries: 2, fetchImpl: async () => { calls += 1; return { status: 500, json: async () => ({}) }; } }),
    (e) => e instanceof TecnoPartnerError && e.code === 'SERVER_ERROR',
  );
  assert.equal(calls, 3); // 1 + 2 retries
});
