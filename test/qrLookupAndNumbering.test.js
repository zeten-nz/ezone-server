/**
 * QR customer lookup + fuel-aware warranty numbering + enriched create
 * response. node:test — no live DB, no real network: the QR-lookup section
 * mounts the REAL routes/warrantyRoutes.js behind the REAL
 * middleware/auth.js on a loopback express server (repositories monkey-
 * patched), numbering tests capture the exact SQL, and the create-response
 * tests drive the real controller with stubbed service/repo. global.fetch
 * is wrapped for the whole file to PROVE no request ever leaves loopback —
 * in particular that a scanned QR value is never fetched (SSRF guard) and
 * no real EasyGas POST happens.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'qr-numbering-test-secret';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../config/database');
const wrepo = require('../repositories/warrantyRepository');
const erepo = require('../repositories/equipmentRepository');
const eclient = require('../services/easyGasWarrantyClient');
const { buildPayload } = require('../services/easyGasWarrantySyncService');
const warrantyService = require('../services/warrantyService');
const controller = require('../controllers/warrantyController');

const SYNTHETIC_CLAIM_URL = 'https://admin.stag.uz/w/test-claim-token';

// ── network guard: every fetch in this file must stay on loopback ──
const fetchedUrls = [];
const realFetch = global.fetch;
global.fetch = (url, opts) => { fetchedUrls.push(String(url)); return realFetch(url, opts); };

// ── users known to verifyToken's DB re-check ──
const USERS = {
  1: { is_active: 1, role: 'EMPLOYEE', is_super_admin: 0 },
  2: { is_active: 1, role: 'ADMIN', is_super_admin: 0 },
};
const tokenFor = (id) => jwt.sign({ id, username: `u${id}`, full_name: `User ${id}` }, process.env.JWT_SECRET);

const state = { claimRows: [], claimCalls: [], easyGasPosts: 0 };

pool.execute = async (sql, params) => {
  if (/SELECT is_active, role, is_super_admin FROM users/.test(sql)) {
    const row = USERS[params[0]];
    return [row ? [row] : []];
  }
  throw new Error(`unexpected pool.execute in test: ${sql}`);
};
pool.getConnection = async () => ({ release() {}, execute: async () => [[]] });

wrepo.findByClaimUrl = async (_conn, claimUrl) => {
  state.claimCalls.push(claimUrl);
  return state.claimRows.map((r) => ({ ...r }));
};
erepo.findByWarrantyFormIds = async (_conn, formIds) =>
  formIds.flatMap((id) => [{
    id: id * 100, warranty_form_id: id, equipment_type: 'REDUCER', product_id: 5,
    product_name: 'REDUCER product', serial_number: 'REDUCER-SN', brand_name: null, model: null,
    inventory_item_id: 777, verification_status: 'AUTO', seller_name: 'SELLER MUST NOT LEAK',
    seller_phone: '+998900000000', validation_response: '{"internal":true}',
  }]);
eclient.submitWarranty = async () => { state.easyGasPosts += 1; return { ok: false, status: 0, data: null, networkError: true }; };

// Raw row carrying every sensitive field the safe DTO must strip.
const dbRow = (over = {}) => ({
  id: 10, employee_id: 999, warranty_book_number: 'LPG-2026-000010', status: 'SUCCESSFUL',
  created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z', installation_date: '2026-08-30',
  submission_uuid: 'uuid-secret', owner_full_name: 'Toshmat Abdullayev', owner_phone: '+998901234567',
  vehicle_name: 'CHEVROLET Cobalt', vehicle_plate_number: '10A100AA', vehicle_vin: 'VIN0001',
  vehicle_production_year: 2021, vehicle_mileage: 42000, fuel_type: 'LPG',
  installer_full_name: 'Usta A', installer_phone: '+998901112233', installer_branch: 'EASY GAS SERVICE',
  installer_branch_code: '01/1', installer_region: 'Toshkent', installer_district: 'Chilonzor',
  easygas_claim_url: SYNTHETIC_CLAIM_URL, easygas_sync_result: 'SUCCESS',
  easygas_sync_error: 'INTERNAL SYNC ERROR MUST NOT LEAK', review_notes: 'ADMIN NOTES MUST NOT LEAK',
  reviewed_by: 2, employee_name: 'Internal Name', employee_username: 'internal_login',
  ...over,
});

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/warranty', require('../routes/warrantyRoutes'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); global.fetch = realFetch; });

beforeEach(() => {
  state.claimRows = [dbRow()];
  state.claimCalls = [];
});

const qrLookup = (qrValue, token, rawBody) =>
  fetch(`${base}/api/warranty/lookup/qr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: rawBody !== undefined ? rawBody : JSON.stringify({ qr_value: qrValue }),
  });

// ════════ Part C — fuel-aware numbering ════════

const seqConn = (nextValue) => {
  const captured = [];
  return {
    captured,
    execute: async (sql, params) => { captured.push({ sql, params }); return [{ insertId: nextValue }]; },
  };
};

test('N1 LPG warranty number: LPG-<year>-<NNNNNN>', async () => {
  const conn = seqConn(10);
  assert.equal(await wrepo.getNextWarrantyNumber(conn, 2026, 'LPG'), 'LPG-2026-000010');
});

test('N2 CNG warranty number: CNG-<year>-<NNNNNN>', async () => {
  const conn = seqConn(11);
  assert.equal(await wrepo.getNextWarrantyNumber(conn, 2026, 'CNG'), 'CNG-2026-000011');
});

test('N3 LPG and CNG draw from the SAME shared yearly sequence (identical SQL, year-only key, no per-fuel counter)', async () => {
  const connA = seqConn(10);
  const connB = seqConn(11);
  await wrepo.getNextWarrantyNumber(connA, 2026, 'LPG');
  await wrepo.getNextWarrantyNumber(connB, 2026, 'CNG');
  // Byte-identical statement and parameters — the fuel type shapes ONLY the
  // formatted prefix, never which sequence row is incremented.
  assert.equal(connA.captured[0].sql, connB.captured[0].sql);
  assert.deepEqual(connA.captured[0].params, connB.captured[0].params);
  assert.match(connA.captured[0].sql, /warranty_number_sequences \(year, last_number\)/);
  assert.ok(!/fuel/i.test(connA.captured[0].sql), 'sequence table must stay keyed by year alone');
});

test('N4 atomic LAST_INSERT_ID idiom preserved on BOTH branches (concurrency guarantees intact)', async () => {
  const conn = seqConn(1);
  await wrepo.getNextWarrantyNumber(conn, 2026, 'LPG');
  const sql = conn.captured[0].sql;
  assert.match(sql, /VALUES \(\?, LAST_INSERT_ID\(1\)\)/);
  assert.match(sql, /ON DUPLICATE KEY UPDATE last_number = LAST_INSERT_ID\(last_number \+ 1\)/);
});

test('N5 invalid fuel type can never produce an arbitrary prefix — throws BEFORE any SQL', async () => {
  for (const bad of ['DIESEL', 'lpg', '', null, undefined, 'W', 'LPG-EXTRA']) {
    const conn = seqConn(1);
    await assert.rejects(() => wrepo.getNextWarrantyNumber(conn, 2026, bad), /Invalid fuel type/);
    assert.equal(conn.captured.length, 0, `no sequence increment may happen for ${JSON.stringify(bad)}`);
  }
});

test('N6/N7 historical W- rows are never rewritten: no warranty_forms UPDATE touches warranty_book_number', async () => {
  // The edit path, executed: captured UPDATE must not carry the number.
  const conn = seqConn(1);
  await wrepo.update(conn, 5, {
    installation_date: '2026-01-01', fuel_type: 'CNG', vehicle_name: 'V', car_id: null,
    vehicle_production_year: 2020, vehicle_plate_number: null, vehicle_vin: 'VIN', vehicle_mileage: 1,
    owner_full_name: 'O', owner_phone: '+998901112233',
  });
  assert.ok(!/warranty_book_number/.test(conn.captured[0].sql), 'edit must never reassign the number');
  // And source-wide: no UPDATE statement in the repository mentions it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'repositories', 'warrantyRepository.js'), 'utf8');
  for (const stmt of src.match(/UPDATE warranty_forms SET[\s\S]*?WHERE/g) || []) {
    assert.ok(!stmt.includes('warranty_book_number'), 'no warranty_forms UPDATE may touch warranty_book_number');
  }
});

test('N8 EasyGas payload forwards the new-format number VERBATIM (no reconstruction)', () => {
  const payload = buildPayload(dbRow({ warranty_book_number: 'CNG-2026-000011' }), [], null);
  assert.equal(payload.warranty_book_number, 'CNG-2026-000011');
  const lpg = buildPayload(dbRow(), [], null);
  assert.equal(lpg.warranty_book_number, 'LPG-2026-000010');
});

// ════════ Part A — QR lookup endpoint ════════

test('Q9 unauthenticated QR lookup is rejected (401), repository never queried', async () => {
  const res = await qrLookup(SYNTHETIC_CLAIM_URL);
  assert.equal(res.status, 401);
  assert.equal(state.claimCalls.length, 0);
});

test('Q10 authenticated EMPLOYEE can perform QR lookup', async () => {
  const res = await qrLookup(SYNTHETIC_CLAIM_URL, tokenFor(1));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).length, 1);
});

test('Q11 authenticated ADMIN can perform QR lookup', async () => {
  const res = await qrLookup(SYNTHETIC_CLAIM_URL, tokenFor(2));
  assert.equal(res.status, 200);
});

test('Q12 the EXACT decoded string reaches the repository verbatim — no trim, no parsing, exact equality only', async () => {
  await qrLookup(SYNTHETIC_CLAIM_URL, tokenFor(1));
  await qrLookup(`  ${SYNTHETIC_CLAIM_URL}  `, tokenFor(1)); // whitespace preserved, not trimmed away
  assert.deepEqual(state.claimCalls, [SYNTHETIC_CLAIM_URL, `  ${SYNTHETIC_CLAIM_URL}  `]);
  // and the repository SQL itself is a parameterized equality — no LIKE
  const src = fs.readFileSync(path.join(__dirname, '..', 'repositories', 'warrantyRepository.js'), 'utf8');
  const fnSrc = src.slice(src.indexOf('const findByClaimUrl'), src.indexOf('const findCreateResult'));
  assert.match(fnSrc, /WHERE wf\.easygas_claim_url = \?/);
  assert.ok(!/LIKE/.test(fnSrc), 'no LIKE / substring matching');
  assert.match(fnSrc, /\[claimUrl\]/);
});

test('Q13 unknown QR value → clean 200 with empty array (same predictable shape as phone lookup)', async () => {
  state.claimRows = [];
  const res = await qrLookup('https://admin.stag.uz/w/unknown-token', tokenFor(1));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test('Q13b validation: missing / non-string / oversized qr_value → 400, repository never queried', async () => {
  for (const body of [
    JSON.stringify({}),
    JSON.stringify({ qr_value: null }),
    JSON.stringify({ qr_value: 42 }),
    JSON.stringify({ qr_value: { url: 'x' } }),
    JSON.stringify({ qr_value: 'x'.repeat(2049) }),
    JSON.stringify({ qr_value: '' }),
  ]) {
    const res = await qrLookup(undefined, tokenFor(1), body);
    assert.equal(res.status, 400, `expected 400 for body ${body.slice(0, 60)}`);
    assert.equal((await res.json()).errorCode, 'VALIDATION_ERROR');
  }
  assert.equal(state.claimCalls.length, 0);
});

test('Q14 the scanned value is NEVER fetched remotely — every request in this file stayed on loopback', async () => {
  await qrLookup(SYNTHETIC_CLAIM_URL, tokenFor(1));
  const external = fetchedUrls.filter((u) => !u.startsWith('http://127.0.0.1'));
  assert.deepEqual(external, [], `no request may leave loopback, saw: ${external[0] || ''}`);
  assert.ok(!fetchedUrls.some((u) => u.includes('admin.stag.uz')), 'the claim URL itself must never be requested');
  assert.equal(state.easyGasPosts, 0, 'no EasyGas POST of any kind during lookups');
  // controller source carries no remote-request primitive at all
  const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'warrantyController.js'), 'utf8');
  assert.ok(!/fetch\(|axios/.test(src), 'warrantyController must never fetch');
});

test('Q15/Q16 QR lookup reuses the SAFE allowlisted DTO — internal/sensitive fields never leak', async () => {
  const res = await qrLookup(SYNTHETIC_CLAIM_URL, tokenFor(1));
  const raw = await res.text();
  for (const forbidden of [
    'easygas_sync_error', 'INTERNAL SYNC ERROR', 'review_notes', 'ADMIN NOTES', 'reviewed_by',
    'validation_response', 'seller_name', 'SELLER MUST NOT LEAK', 'seller_phone', 'verification_status',
    'inventory_item_id', 'submission_uuid', 'employee_username', 'internal_login', 'easygas_sync_result',
  ]) {
    assert.ok(!raw.includes(forbidden), `response must not contain "${forbidden}"`);
  }
  const item = JSON.parse(raw)[0];
  assert.equal(item.warranty_book_number, 'LPG-2026-000010');
  assert.equal(item.owner_full_name, 'Toshmat Abdullayev');
  assert.equal(item.fuel_type, 'LPG');
  assert.equal(item.easygas_claim_url, SYNTHETIC_CLAIM_URL); // deliberately allowed (QR re-display)
  assert.equal(item.installer.branch, 'EASY GAS SERVICE');
  assert.equal(item.equipment[0].serial_number, 'REDUCER-SN');
});

// ════════ Part B — enriched create response ════════

const mkRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

async function runCreate(createResult, storedRow) {
  const orig = { create: warrantyService.createWarrantyForm, submit: warrantyService.submitWarrantyToEasyGas, getConn: pool.getConnection, findCreate: wrepo.findCreateResult };
  const st = { submitCount: 0 };
  warrantyService.createWarrantyForm = async () => createResult;
  warrantyService.submitWarrantyToEasyGas = async () => { st.submitCount += 1; };
  wrepo.findCreateResult = async (_conn, formId) => ({ id: formId, ...storedRow });
  pool.getConnection = async () => ({ release() {} });
  const res = mkRes();
  try {
    await controller.createWarrantyForm({ user: { id: 1 }, body: {} }, res, (e) => { throw e; });
  } finally {
    warrantyService.createWarrantyForm = orig.create; warrantyService.submitWarrantyToEasyGas = orig.submit; pool.getConnection = orig.getConn; wrepo.findCreateResult = orig.findCreate;
  }
  return { res, st };
}

test('C17 create + EasyGas SUCCESS → allowlisted response with number, fuel, SUCCESS, claim_url', async () => {
  const { res, st } = await runCreate({ formId: 42, created: true }, {
    warranty_book_number: 'LPG-2026-000010', fuel_type: 'LPG', status: 'SUCCESSFUL',
    easygas_sync_result: 'SUCCESS', easygas_claim_url: SYNTHETIC_CLAIM_URL,
    easygas_sync_error: 'MUST NOT LEAK EVEN IF SELECTED',
  });
  assert.equal(res.statusCode, 201);
  assert.equal(st.submitCount, 1);
  assert.equal(res.body.warranty_book_number, 'LPG-2026-000010');
  assert.equal(res.body.fuel_type, 'LPG');
  assert.equal(res.body.easygas_sync_result, 'SUCCESS');
  assert.equal(res.body.easygas_claim_url, SYNTHETIC_CLAIM_URL);
  assert.ok(!('easygas_sync_error' in res.body), 'sync error text must never reach the employee create UI');
});

test('C18 create + EasyGas FAILED → LOCAL success metadata, sync_result FAILED, claim_url null, no error text', async () => {
  const { res } = await runCreate({ formId: 43, created: true }, {
    warranty_book_number: 'CNG-2026-000011', fuel_type: 'CNG', status: 'SUCCESSFUL',
    easygas_sync_result: 'FAILED', easygas_claim_url: null, easygas_sync_error: 'HTTP 422: MUST NOT LEAK',
  });
  assert.equal(res.statusCode, 201); // the LOCAL create is still a success
  assert.equal(res.body.warranty_book_number, 'CNG-2026-000011');
  assert.equal(res.body.status, 'SUCCESSFUL');
  assert.equal(res.body.easygas_sync_result, 'FAILED');
  assert.equal(res.body.easygas_claim_url, null);
  assert.ok(!JSON.stringify(res.body).includes('MUST NOT LEAK'));
});

test('C18b sync attempt crashed before recording (stored NULL) → reported FAILED with null claim_url', async () => {
  const { res } = await runCreate({ formId: 44, created: true }, {
    warranty_book_number: 'LPG-2026-000012', fuel_type: 'LPG', status: 'SUCCESSFUL',
    easygas_sync_result: null, easygas_claim_url: null,
  });
  assert.equal(res.body.easygas_sync_result, 'FAILED');
  assert.equal(res.body.easygas_claim_url, null);
});

test('C19 submission_uuid replay → ZERO EasyGas POSTs, SAME stored number/claim state, 200 (no second warranty/number)', async () => {
  const { res, st } = await runCreate({ formId: 42, created: false }, {
    warranty_book_number: 'LPG-2026-000010', fuel_type: 'LPG', status: 'SUCCESSFUL',
    easygas_sync_result: 'SUCCESS', easygas_claim_url: SYNTHETIC_CLAIM_URL,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(st.submitCount, 0, 'a replay must not re-POST to EasyGas');
  assert.equal(res.body.id, 42);
  assert.equal(res.body.warranty_book_number, 'LPG-2026-000010'); // same number, never a second one
  assert.equal(res.body.easygas_claim_url, SYNTHETIC_CLAIM_URL);
});
