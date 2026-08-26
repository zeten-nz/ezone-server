/**
 * Automatic EasyGas submission immediately after warranty creation, no admin approval (rule 7). node:test, no DB /
 * no network — deps are stubbed. Verifies: new warranty is SUCCESSFUL (not PENDING); exactly one EasyGas POST on a
 * real create; zero POSTs on an idempotent retry; SUCCESS stores the exact claim_url; FAILED records the failure
 * without rolling back; a submission error never fails the (already-committed) create; no automatic retry; the admin
 * review path still guards PENDING so historical rows stay reviewable.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const wrepo = require('../repositories/warrantyRepository');
const erepo = require('../repositories/equipmentRepository');
const crepo = require('../repositories/carRepository');
const eclient = require('../services/easyGasWarrantyClient');
const syncSvc = require('../services/easyGasWarrantySyncService');
const warrantyService = require('../services/warrantyService');
const controller = require('../controllers/warrantyController');
const { pool } = require('../config/database');

const mkRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

// ── status is SUCCESSFUL on create ──
test('§7 new warranty is inserted with status SUCCESSFUL, never PENDING', async () => {
  let captured;
  const conn = { execute: async (sql, params) => { captured = { sql, params }; return [{ insertId: 42 }]; } };
  const snapshot = { region: 'R', city: 'C', district: 'D', branch_name: 'B', branch_phone: 'p', full_name: 'F', installer_phone: 'ip', branch_code: 'BC' };
  const data = { submission_uuid: 'u', installation_date: '2026-01-01', fuel_type: 'LPG', vehicle_name: 'V', car_id: null, vehicle_production_year: 2020, vehicle_plate_number: '01', vehicle_vin: 'VIN', vehicle_mileage: 1, owner_full_name: 'O', owner_phone: '+998901112233' };
  const id = await wrepo.insert(conn, 5, snapshot, data, 'W-1');
  assert.equal(id, 42);
  assert.match(captured.sql, /status/);
  assert.match(captured.sql, /'SUCCESSFUL'/);
  assert.doesNotMatch(captured.sql, /PENDING/);
});

test('§7 admin reviewForm still guards WHERE status = PENDING (historical PENDING remain reviewable)', async () => {
  let captured;
  const conn = { execute: async (sql, params) => { captured = { sql, params }; return [{ affectedRows: 1 }]; } };
  await wrepo.reviewForm(conn, { formId: 7, decision: 'SUCCESSFUL', reviewedBy: 1, notes: 'x' });
  assert.match(captured.sql, /status = 'PENDING'/); // new SUCCESSFUL rows are immune; old PENDING rows still transition
});

// ── syncWarrantyForm: exactly-once POST, SUCCESS/FAILED recording ──
function stubSync({ submitImpl }) {
  const orig = { fd: wrepo.findDetailById, up: wrepo.updateEasyGasSyncResult, eq: erepo.findByWarrantyFormIds, car: crepo.findById, submit: eclient.submitWarranty };
  const state = { postCount: 0, recorded: null };
  const form = {
    id: 42, submission_uuid: 'u', warranty_book_number: 'W-1', installer_branch_code: '01/1', fuel_type: 'LPG',
    installer_full_name: 'F', installer_branch: 'B', organization_phone: '+998 90 111 22 33', installation_date: '2026-01-01',
    installer_region: 'R', city: 'C', installer_district: 'D', car_id: null, vehicle_brand: 'VB', vehicle_model: 'VM',
    vehicle_production_year: 2020, vehicle_vin: 'VIN', vehicle_mileage: 1, vehicle_plate_number: '01',
    owner_full_name: 'O', owner_phone: '+998 90 123 45 67',
  };
  wrepo.findDetailById = async () => ({ ...form });
  erepo.findByWarrantyFormIds = async () => [{ warranty_form_id: 42, equipment_type: 'REDUCER', product_id: 1, product_external_id: 100, serial_number: 'R1' }];
  crepo.findById = async () => null;
  eclient.submitWarranty = async () => { state.postCount += 1; return submitImpl(); };
  wrepo.updateEasyGasSyncResult = async (_c, _id, payload) => { state.recorded = payload; };
  const restore = () => { wrepo.findDetailById = orig.fd; wrepo.updateEasyGasSyncResult = orig.up; erepo.findByWarrantyFormIds = orig.eq; crepo.findById = orig.car; eclient.submitWarranty = orig.submit; };
  const fakePool = { getConnection: async () => ({ release() {} }) };
  return { state, restore, fakePool };
}

test('§7 syncWarrantyForm SUCCESS → exactly ONE POST, stores the EXACT claim_url, no retry', async () => {
  const { state, restore, fakePool } = stubSync({ submitImpl: () => ({ ok: true, status: 201, data: { warranty: { claim_url: 'https://easygas.uz/w/xyz' } } }) });
  try {
    await syncSvc.syncWarrantyForm(fakePool, 42);
    assert.equal(state.postCount, 1); // exactly one submission, no automatic retry
    assert.equal(state.recorded.result, 'SUCCESS');
    assert.equal(state.recorded.claimUrl, 'https://easygas.uz/w/xyz');
    assert.equal(state.recorded.error, null);
  } finally { restore(); }
});

test('§7 syncWarrantyForm FAILED → records FAILED + error, claim_url NULL, one POST, no rollback', async () => {
  const { state, restore, fakePool } = stubSync({ submitImpl: () => ({ ok: false, status: 422, networkError: false, data: { errors: [{ code: 'PRODUCT_UNKNOWN' }] } }) });
  try {
    await syncSvc.syncWarrantyForm(fakePool, 42);
    assert.equal(state.postCount, 1);
    assert.equal(state.recorded.result, 'FAILED');
    assert.equal(state.recorded.claimUrl, null);
    assert.match(state.recorded.error, /HTTP 422/); // failure recorded; the warranty row itself is untouched (no status change here)
  } finally { restore(); }
});

// ── controller gating: created→sync once, not-created→zero, sync error doesn't fail create ──
async function runController(createResult, submitImpl) {
  const orig = { create: warrantyService.createWarrantyForm, submit: warrantyService.submitWarrantyToEasyGas, getConn: pool.getConnection };
  const state = { submitCount: 0, released: 0 };
  warrantyService.createWarrantyForm = async () => createResult;
  warrantyService.submitWarrantyToEasyGas = async () => { state.submitCount += 1; if (submitImpl) return submitImpl(); };
  pool.getConnection = async () => ({ release() { state.released += 1; } });
  const res = mkRes();
  try {
    await controller.createWarrantyForm({ user: { id: 1 }, body: {} }, res, (e) => { throw e; });
  } finally {
    warrantyService.createWarrantyForm = orig.create; warrantyService.submitWarrantyToEasyGas = orig.submit; pool.getConnection = orig.getConn;
  }
  return { res, state };
}

test('§7 a NEW create (created=true) triggers exactly ONE EasyGas submission → 201', async () => {
  const { res, state } = await runController({ formId: 42, created: true });
  assert.equal(state.submitCount, 1);
  assert.equal(res.statusCode, 201);
});

test('§7 an idempotent submission_uuid retry (created=false) triggers ZERO submissions → 200', async () => {
  const { res, state } = await runController({ formId: 42, created: false });
  assert.equal(state.submitCount, 0); // the duplicate POST must NOT re-submit to EasyGas
  assert.equal(res.statusCode, 200);
});

test('§7 an EasyGas submission error does NOT fail the create (warranty committed; no rollback)', async () => {
  const { res, state } = await runController({ formId: 42, created: true }, () => { throw new Error('boom'); });
  assert.equal(state.submitCount, 1);
  assert.equal(res.statusCode, 201); // create still succeeds despite the sync throwing
});
