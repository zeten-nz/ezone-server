/**
 * Authenticated customer lookup by phone (Beta-1, Part G). node:test — no live DB, no network beyond a loopback
 * express server. Mounts the REAL routes/warrantyRoutes.js behind the REAL middleware/auth.js (real JWT verify), with
 * config/database's pool and the repositories monkey-patched, so auth, route ordering (/lookup before /:formId), the
 * controller, and the safe DTO are all exercised exactly as production wires them.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'customer-lookup-test-secret';

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

// ── users known to verifyToken's DB re-check ──
const USERS = {
  1: { is_active: 1, role: 'EMPLOYEE', is_super_admin: 0 },
  2: { is_active: 1, role: 'ADMIN', is_super_admin: 0 },
};
const tokenFor = (id) => jwt.sign({ id, username: `u${id}`, full_name: `User ${id}` }, process.env.JWT_SECRET);

// ── patched infrastructure ──
const state = {
  rows: [],                 // what findByOwnerPhone returns
  equipmentByFormId: {},    // what findByWarrantyFormIds returns, grouped
  lookupCalls: [],          // normalizedPhone values findByOwnerPhone received
  equipmentQueryCount: 0,   // batched-query proof
  easyGasPosts: 0,          // must stay 0
};

pool.execute = async (sql, params) => {
  if (/SELECT is_active, role, is_super_admin FROM users/.test(sql)) {
    const row = USERS[params[0]];
    return [row ? [row] : []];
  }
  throw new Error(`unexpected pool.execute in test: ${sql}`);
};
pool.getConnection = async () => ({ release() {}, execute: async () => [[]] });

wrepo.findByOwnerPhone = async (_conn, normalizedPhone) => {
  state.lookupCalls.push(normalizedPhone);
  return state.rows.map((r) => ({ ...r }));
};
erepo.findByWarrantyFormIds = async (_conn, formIds) => {
  state.equipmentQueryCount += 1;
  return formIds.flatMap((id) => state.equipmentByFormId[id] || []);
};
eclient.submitWarranty = async () => { state.easyGasPosts += 1; return { ok: false, status: 0, data: null, networkError: true }; };

// A "raw DB row" carrying every sensitive field the safe DTO must strip.
const dbRow = (over = {}) => ({
  id: 10, employee_id: 999, warranty_book_number: 'W-2026-000010', status: 'SUCCESSFUL',
  created_at: '2026-08-01T10:00:00Z', updated_at: '2026-08-01T10:00:00Z', installation_date: '2026-07-30',
  submission_uuid: 'uuid-secret', owner_full_name: 'Toshmat Abdullayev', owner_phone: '+998901234567',
  vehicle_name: 'CHEVROLET Cobalt', vehicle_plate_number: '10A100AA', vehicle_vin: 'VIN0001',
  vehicle_production_year: 2021, vehicle_mileage: 42000, fuel_type: 'LPG',
  installer_full_name: 'Usta A', installer_phone: '+998901112233', installer_branch: 'EASY GAS SERVICE',
  installer_branch_code: '01/1', installer_region: 'Toshkent', installer_district: 'Chilonzor',
  easygas_claim_url: 'https://gasgo.uz/w/abc', easygas_sync_result: 'SUCCESS',
  easygas_sync_error: 'INTERNAL SYNC ERROR MUST NOT LEAK', review_notes: 'ADMIN NOTES MUST NOT LEAK',
  reviewed_by: 2, employee_name: 'Internal Name', employee_username: 'internal_login',
  ...over,
});
const equipmentRow = (formId, type, over = {}) => ({
  id: formId * 100, warranty_form_id: formId, equipment_type: type, product_id: 5,
  product_name: `${type} product`, serial_number: `${type}-SN`, brand_name: null, model: null,
  inventory_item_id: 777, verification_status: 'AUTO', seller_name: 'SELLER MUST NOT LEAK',
  seller_phone: '+998900000000', verification_comment: null, manual_verification_photo_filename: null,
  validation_response: '{"internal":true}',
  ...over,
});

// ── the real app under test ──
let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/warranty', require('../routes/warrantyRoutes'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
  state.rows = [dbRow()];
  state.equipmentByFormId = { 10: ['REDUCER', 'CYLINDER', 'CONTROLLER', 'INJECTOR_RAIL'].map((t) => equipmentRow(10, t)) };
  state.lookupCalls = [];
  state.equipmentQueryCount = 0;
});

const lookup = (phone, token) =>
  fetch(`${base}/api/warranty/lookup?phone=${encodeURIComponent(phone)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

test('G1 unauthenticated lookup is rejected (401), no query runs', async () => {
  const res = await lookup('+998901234567');
  assert.equal(res.status, 401);
  assert.equal(state.lookupCalls.length, 0);
});

test('G2 authenticated EMPLOYEE is allowed', async () => {
  const res = await lookup('+998901234567', tokenFor(1));
  assert.equal(res.status, 200);
});

test('G3 authenticated ADMIN is allowed', async () => {
  const res = await lookup('+998901234567', tokenFor(2));
  assert.equal(res.status, 200);
});

test('G4 employee sees a warranty created by ANOTHER employee/branch (cross-installer access)', async () => {
  state.rows = [dbRow({ employee_id: 999, installer_branch_code: '99/9' })]; // not the requester (id 1)
  const res = await lookup('+998901234567', tokenFor(1));
  const body = await res.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].installer.branch_code, '99/9');
});

test('G5/G6/G7 +998, human-formatted, and bare 9-digit inputs all normalize to the SAME 9-digit key', async () => {
  await lookup('+998901234567', tokenFor(1));
  await lookup('+998 90 123 45 67', tokenFor(1));
  await lookup('901234567', tokenFor(1));
  assert.deepEqual(state.lookupCalls, ['901234567', '901234567', '901234567']);
});

test('G8 invalid / too-short phone → 400 VALIDATION_ERROR, repository never queried', async () => {
  for (const bad of ['', 'abc', '12345', '99']) {
    const res = await lookup(bad, tokenFor(1));
    assert.equal(res.status, 400, `expected 400 for "${bad}"`);
    const body = await res.json();
    assert.equal(body.errorCode, 'VALIDATION_ERROR');
  }
  assert.equal(state.lookupCalls.length, 0);
});

test('G9 unrelated phone → 200 with empty array', async () => {
  state.rows = [];
  const res = await lookup('+998900000001', tokenFor(1));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test('G10/G11/G12 multiple warranties/vehicles come back as separate items in repository (newest-first) order', async () => {
  state.rows = [
    dbRow({ id: 20, created_at: '2026-08-20T09:00:00Z', vehicle_name: 'BYD Song', vehicle_plate_number: '01B200BB' }),
    dbRow({ id: 10, created_at: '2026-08-01T10:00:00Z' }),
  ];
  state.equipmentByFormId = {
    10: [equipmentRow(10, 'REDUCER')],
    20: [equipmentRow(20, 'REDUCER')],
  };
  const body = await (await lookup('+998901234567', tokenFor(1))).json();
  assert.equal(body.length, 2);
  assert.equal(body[0].id, 20); // repo order preserved (SQL ORDER BY created_at DESC)
  assert.equal(body[0].vehicle_name, 'BYD Song');
  assert.equal(body[1].vehicle_name, 'CHEVROLET Cobalt'); // vehicles never merged
});

test('G11b/G20 repository SQL orders newest-first and stays parameterized', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'repositories', 'warrantyRepository.js'), 'utf8');
  const fnSrc = src.slice(src.indexOf('const findByOwnerPhone'), src.indexOf('const deleteById'));
  assert.match(fnSrc, /ORDER BY wf\.created_at DESC/);
  assert.match(fnSrc, /RIGHT\(REGEXP_REPLACE\(wf\.owner_phone, '\[\^0-9\]', ''\), 9\) = \?/);
  assert.match(fnSrc, /\[normalizedPhone\]/); // bound as a parameter array
  assert.ok(!/\$\{normalizedPhone\}/.test(fnSrc), 'phone must never be template-interpolated into SQL');
});

test('G13/G14 all equipment attached via ONE batched query for the whole result set (no N+1)', async () => {
  state.rows = [dbRow({ id: 10 }), dbRow({ id: 20 }), dbRow({ id: 30 })];
  state.equipmentByFormId = { 10: [equipmentRow(10, 'REDUCER')], 20: [equipmentRow(20, 'CYLINDER')], 30: [] };
  const body = await (await lookup('+998901234567', tokenFor(1))).json();
  assert.equal(state.equipmentQueryCount, 1, 'equipment must be fetched once per lookup, not per warranty');
  assert.equal(body[0].equipment.length, 1);
  assert.equal(body[0].equipment[0].serial_number, 'REDUCER-SN');
});

test('G15 missing equipment slot (only 3 rows) is returned as-is, no crash, no fake data', async () => {
  state.equipmentByFormId = { 10: ['REDUCER', 'CONTROLLER', 'INJECTOR_RAIL'].map((t) => equipmentRow(10, t)) };
  const body = await (await lookup('+998901234567', tokenFor(1))).json();
  assert.equal(body[0].equipment.length, 3);
  assert.ok(!body[0].equipment.some((e) => e.equipment_type === 'CYLINDER'));
});

test('G16 typed historical cylinder keeps brand_name/model', async () => {
  state.equipmentByFormId = { 10: [equipmentRow(10, 'CYLINDER', { product_id: null, product_name: '', brand_name: 'GZWM', model: '60L Toroidal' })] };
  const body = await (await lookup('+998901234567', tokenFor(1))).json();
  const cyl = body[0].equipment[0];
  assert.equal(cyl.brand_name, 'GZWM');
  assert.equal(cyl.model, '60L Toroidal');
});

test('G17/G18/G19 safe response excludes every internal/admin field (allowlist proof)', async () => {
  const res = await lookup('+998901234567', tokenFor(1));
  const raw = await res.text();
  for (const forbidden of [
    'easygas_sync_error', 'INTERNAL SYNC ERROR', 'review_notes', 'ADMIN NOTES', 'reviewed_by',
    'validation_response', 'seller_name', 'SELLER MUST NOT LEAK', 'seller_phone', 'verification_status',
    'inventory_item_id', 'submission_uuid', 'employee_username', 'internal_login', 'easygas_sync_result',
  ]) {
    assert.ok(!raw.includes(forbidden), `response must not contain "${forbidden}"`);
  }
  const item = JSON.parse(raw)[0];
  assert.equal(item.owner_full_name, 'Toshmat Abdullayev');
  assert.equal(item.easygas_claim_url, 'https://gasgo.uz/w/abc'); // deliberately allowed (QR)
  assert.equal(item.installer.branch, 'EASY GAS SERVICE');
});

test('G21 the old public customer-warranty endpoint no longer exists anywhere', async () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'routes', 'publicCustomerRoutes.js')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'controllers', 'publicCustomerController.js')), false);
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!serverSrc.includes("app.use('/api/public/customer'"), 'server.js must not mount the public customer route');
  assert.ok(!serverSrc.includes('publicCustomerRoutes'), 'server.js must not require the deleted router');
});

test('G22 no EasyGas request of any kind during lookups', () => {
  assert.equal(state.easyGasPosts, 0);
});
