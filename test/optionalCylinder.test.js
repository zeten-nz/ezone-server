/**
 * Optional cylinder (Beta-3, Parts 20-24). node:test — no DB, no network.
 * Repos/points/EasyGas client are monkey-patched (same convention as
 * warrantyAutoSubmit.test.js); the REAL warrantyService, equipment
 * invariant, payload builder, CSV columns and DTOs are exercised.
 */
process.env.EASYGAS_WARRANTY_API_BASE_URL = process.env.EASYGAS_WARRANTY_API_BASE_URL || 'https://easygas.invalid/api/integrations/warranty';
process.env.EASYGAS_SHARED_SECRET = process.env.EASYGAS_SHARED_SECRET || 'beta3-test-secret';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const wrepo = require('../repositories/warrantyRepository');
const erepo = require('../repositories/equipmentRepository');
const crepo = require('../repositories/carRepository');
const productRepo = require('../repositories/productRepository');
const pointsService = require('../services/pointsService');
const eclient = require('../services/easyGasWarrantyClient');
const syncSvc = require('../services/easyGasWarrantySyncService');
const easyGasSyncModule = require('../services/easyGasWarrantySyncService');
const warrantyService = require('../services/warrantyService');
const { getLabels } = require('../config/csvLabels');
const { buildWarrantyColumns } = require('../utils/warrantyCsvColumns');
const { toWarrantyResponse, toWarrantyLookupResponse } = require('../dtos/warrantyDTO');

// ── shared patch state ──
const state = {
  upserted: null, deleted: [], awards: [], reversals: [], existingRows: [], upsertShouldThrow: false,
  rollbacks: 0, commits: 0, synced: [],
};
wrepo.getEmployeeSnapshot = async () => ({ installer_branch: 'B', installer_branch_code: '01/1' });
wrepo.findBySubmissionUuid = async () => null;
wrepo.getNextWarrantyNumber = async () => 'W-2026-000777';
wrepo.insert = async () => 77;
wrepo.update = async () => {};
wrepo.findOwnershipInfo = async () => ({ employee_id: 9, created_at: new Date().toISOString() });
wrepo.lockForm = async () => ({ id: 77 });
erepo.upsertMany = async (_c, _id, rows) => { if (state.upsertShouldThrow) throw new Error('boom'); state.upserted = rows; };
erepo.findByWarrantyFormIds = async () => state.existingRows.map((r) => ({ ...r }));
erepo.deleteByFormAndType = async (_c, formId, type) => { state.deleted.push({ formId, type }); return 1; };
productRepo.findById = async (_c, id) => (id === 666 ? { id, brand: 'STALE', model: 'X', is_active: false } : { id, brand: 'STAG', model: `M${id}`, is_active: true });
pointsService.awardForEquipmentRow = async (_c, args) => { state.awards.push(args); };
pointsService.reverseForEquipmentRow = async (_c, args) => { state.reversals.push(args); };
easyGasSyncModule.syncWarrantyForm = easyGasSyncModule.syncWarrantyForm; // (payload tests call it with their own patches)

const conn = {
  beginTransaction: async () => {},
  commit: async () => { state.commits += 1; },
  rollback: async () => { state.rollbacks += 1; },
  execute: async () => [[]],
};

const R = (over = {}) => ({ equipment_type: 'REDUCER', product_id: 1, serial_number: 'SR-1', ...over });
const C = (over = {}) => ({ equipment_type: 'CONTROLLER', product_id: 2, serial_number: 'SN-2', ...over });
const I = (over = {}) => ({ equipment_type: 'INJECTOR_RAIL', product_id: 3, serial_number: 'SI-3', ...over });
const CYL = (over = {}) => ({ equipment_type: 'CYLINDER', product_id: 4, serial_number: 'SC-4', ...over });
const THREE = () => [R(), C(), I()];

const createForm = (equipment, uuid = `u-${Math.random()}`) =>
  warrantyService.createWarrantyForm(conn, 9, { submission_uuid: uuid, equipment });

const stored = (type, over = {}) => ({
  id: { REDUCER: 201, CYLINDER: 202, CONTROLLER: 203, INJECTOR_RAIL: 204 }[type],
  equipment_type: type, product_id: { REDUCER: 1, CYLINDER: 4, CONTROLLER: 2, INJECTOR_RAIL: 3 }[type],
  serial_number: { REDUCER: 'SR-1', CYLINDER: 'SC-4', CONTROLLER: 'SN-2', INJECTOR_RAIL: 'SI-3' }[type],
  model: null, brand_name: null, inventory_item_id: null, verification_status: 'AUTO',
  seller_name: null, seller_phone: null, verification_comment: null, manual_verification_photo_filename: null,
  product_name: `P${type}`, ...over,
});

beforeEach(() => {
  state.upserted = null; state.deleted = []; state.awards = []; state.reversals = [];
  state.existingRows = []; state.upsertShouldThrow = false; state.rollbacks = 0; state.commits = 0;
});

// ══ Part 20 — validation ══
test('20.1/2/3 create with only the 3 required types succeeds — exactly 3 rows, NO cylinder row, no fake placeholders', async () => {
  state.existingRows = THREE().map((r2, i) => ({ ...stored(r2.equipment_type), id: 300 + i }));
  const result = await createForm(THREE());
  assert.equal(result.created, true);
  assert.equal(state.upserted.length, 3);
  assert.ok(!state.upserted.some((r2) => r2.equipment_type === 'CYLINDER'));
  assert.ok(state.upserted.every((r2) => r2.product_id !== null && r2.serial_number));
  assert.equal(state.awards.length, 3); // points for the 3 present rows only (20.5→Part 4)
});

test('20.4/14 create with all 4 (catalog cylinder) still succeeds', async () => {
  state.existingRows = [stored('REDUCER'), stored('CYLINDER'), stored('CONTROLLER'), stored('INJECTOR_RAIL')];
  const result = await createForm([R(), CYL(), C(), I()]);
  assert.equal(result.created, true);
  assert.equal(state.upserted.length, 4);
  assert.equal(state.awards.length, 4);
});

test('20.5/6/7 each missing REQUIRED type is rejected', async () => {
  for (const missing of ['REDUCER', 'CONTROLLER', 'INJECTOR_RAIL']) {
    const rows = [R(), C(), I(), CYL()].filter((r2) => r2.equipment_type !== missing);
    await assert.rejects(() => createForm(rows), (e) => e.errorCode === 'EQUIPMENT_INCOMPLETE', `missing ${missing}`);
  }
});

test('20.8 a cylinder cannot substitute for a required type', async () => {
  await assert.rejects(() => createForm([R(), CYL(), C()]), (e) => e.errorCode === 'EQUIPMENT_INCOMPLETE');
});

test('20.9/10 duplicate types rejected — incl. duplicate CYLINDER', async () => {
  await assert.rejects(() => createForm([R(), R(), C(), I()]), (e) => e.errorCode === 'EQUIPMENT_INCOMPLETE');
  await assert.rejects(() => createForm([R(), C(), I(), CYL(), CYL({ serial_number: 'SC-5' })]), (e) => e.errorCode === 'EQUIPMENT_INCOMPLETE');
});

test('20.11 unknown equipment type rejected', async () => {
  await assert.rejects(() => createForm([R(), C(), I(), { equipment_type: 'TANK', product_id: 5, serial_number: 'X' }]), (e) => e.errorCode === 'EQUIPMENT_INCOMPLETE');
});

test('20.12 malformed present cylinder rejected (catalog without serial; typed without model)', async () => {
  await assert.rejects(() => createForm([R(), C(), I(), CYL({ serial_number: null })]), (e) => e.errorCode === 'BARCODE_REQUIRED');
  await assert.rejects(() => createForm([R(), C(), I(), { equipment_type: 'CYLINDER', product_id: null, model: '  ' }]), (e) => e.errorCode === 'CYLINDER_MODEL_REQUIRED');
});

test('20.13 inactive cylinder catalog product still rejected — optionality does not bypass enforcement', async () => {
  await assert.rejects(() => createForm([R(), C(), I(), CYL({ product_id: 666 })]), (e) => e.errorCode === 'PRODUCT_INACTIVE');
});

test('20.15 typed/manual cylinder still valid', async () => {
  state.existingRows = [stored('REDUCER'), stored('CYLINDER', { product_id: null, brand_name: 'GZWM', model: '60L' }), stored('CONTROLLER'), stored('INJECTOR_RAIL')];
  const result = await createForm([R(), C(), I(), { equipment_type: 'CYLINDER', product_id: null, brand_name: 'GZWM', model: '60L', serial_number: 'SC-9' }]);
  assert.equal(result.created, true);
  const cyl = state.upserted.find((r2) => r2.equipment_type === 'CYLINDER');
  assert.equal(cyl.brand_name, 'GZWM');
  assert.equal(cyl.product_id, null);
});

// ══ Part 21 — EasyGas contract ══
const FORM_ROW = {
  id: 77, submission_uuid: 'u-1', warranty_book_number: 'W-2026-000777', installer_branch_code: '01/1',
  fuel_type: 'LPG', installer_full_name: 'F', installer_branch: 'B', organization_phone: '+998983022844',
  installation_date: '2026-09-01', installer_region: 'R', city: 'C', installer_district: 'D', car_id: null,
  vehicle_brand: 'VB', vehicle_model: 'VM', vehicle_production_year: 2021, vehicle_vin: 'VIN', vehicle_mileage: 1,
  vehicle_plate_number: '01A', owner_full_name: 'O', owner_phone: '+998901234567',
};
const payloadFor = async (equipmentRows) => {
  const orig = { fd: wrepo.findDetailById, up: wrepo.updateEasyGasSyncResult, eq: erepo.findByWarrantyFormIds, car: crepo.findById, submit: eclient.submitWarranty };
  let rawBody;
  let recorded;
  wrepo.findDetailById = async () => ({ ...FORM_ROW });
  wrepo.updateEasyGasSyncResult = async (_c, _id, resu) => { recorded = resu; };
  erepo.findByWarrantyFormIds = async () => equipmentRows;
  crepo.findById = async () => null;
  eclient.submitWarranty = async (body) => { rawBody = body; return { ok: true, status: 201, data: { warranty: { claim_url: 'https://gasgo.uz/w/x' } }, networkError: false }; };
  try {
    await syncSvc.syncWarrantyForm({ getConnection: async () => ({ release() {} }) }, 77);
  } finally {
    Object.assign(wrepo, { findDetailById: orig.fd, updateEasyGasSyncResult: orig.up });
    erepo.findByWarrantyFormIds = orig.eq; crepo.findById = orig.car; eclient.submitWarranty = orig.submit;
  }
  return { rawBody, payload: JSON.parse(rawBody), recorded };
};
const eq = (type, over = {}) => ({ warranty_form_id: 77, equipment_type: type, product_id: 1, product_external_id: { REDUCER: 251, CONTROLLER: 215, INJECTOR_RAIL: 240, CYLINDER: 233 }[type], serial_number: `${type}-SN`, brand_name: null, model: null, ...over });

test('21.16/17/20 NO-cylinder warranty sends the cylinder ENTRY with ALL cylinder fields as JSON null — present keys, no fakes, canonical position', async () => {
  const { rawBody, payload } = await payloadFor([eq('REDUCER'), eq('CONTROLLER'), eq('INJECTOR_RAIL')]);
  assert.equal(payload.components.length, 4);
  const cyl = payload.components[1]; // canonical position: right after the reducer
  assert.deepEqual(cyl, { component_type: 'cylinder', serial_number: null, product_id: null, brand_name: null, model: null });
  // keys survive serialization as JSON null — never undefined/dropped:
  assert.ok(rawBody.includes('"component_type":"cylinder"'));
  assert.ok(rawBody.includes('"product_id":null'));
  assert.ok(rawBody.includes('"serial_number":null'));
  assert.ok(rawBody.includes('"brand_name":null'));
  assert.deepEqual(payload.components.map((c2) => c2.component_type), ['reducer', 'cylinder', 'controller', 'injector']);
});

test('21.18 catalog cylinder maps exactly as before (external product id, no null padding)', async () => {
  const { payload } = await payloadFor([eq('REDUCER'), eq('CYLINDER'), eq('CONTROLLER'), eq('INJECTOR_RAIL')]);
  const cyl = payload.components.find((c2) => c2.component_type === 'cylinder');
  assert.deepEqual(cyl, { component_type: 'cylinder', serial_number: 'CYLINDER-SN', product_id: 233 });
});

test('21.19 typed cylinder maps exactly as before (brand_name+model, no product_id)', async () => {
  const { payload } = await payloadFor([eq('REDUCER'), eq('CYLINDER', { product_id: null, product_external_id: null, brand_name: 'GZWM', model: '60L Toroidal' }), eq('CONTROLLER'), eq('INJECTOR_RAIL')]);
  const cyl = payload.components.find((c2) => c2.component_type === 'cylinder');
  assert.deepEqual(cyl, { component_type: 'cylinder', serial_number: 'CYLINDER-SN', brand_name: 'GZWM', model: '60L Toroidal' });
});

test('21.22 the REAL client signs the exact serialized body it transmits (HMAC untouched)', async () => {
  let captured;
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => { captured = opts; return { ok: true, status: 201, json: async () => ({}) }; };
  try {
    const body = JSON.stringify({ probe: true, components: [null] });
    await eclient.submitWarranty(body);
    const expected = `sha256=${crypto.createHmac('sha256', process.env.EASYGAS_SHARED_SECRET).update(`${captured.headers['X-EG-Timestamp']}.${body}`).digest('hex')}`;
    assert.equal(captured.headers['X-EG-Signature'], expected);
    assert.equal(captured.body, body); // signed bytes === transmitted bytes
  } finally {
    global.fetch = origFetch;
  }
});

test('22.27/29 no-cylinder EasyGas FAILURE records FAILED and never throws/rolls back the local warranty', async () => {
  const orig = { fd: wrepo.findDetailById, up: wrepo.updateEasyGasSyncResult, eq: erepo.findByWarrantyFormIds, car: crepo.findById, submit: eclient.submitWarranty };
  let recorded;
  wrepo.findDetailById = async () => ({ ...FORM_ROW });
  wrepo.updateEasyGasSyncResult = async (_c, _id, resu) => { recorded = resu; };
  erepo.findByWarrantyFormIds = async () => [eq('REDUCER'), eq('CONTROLLER'), eq('INJECTOR_RAIL')];
  crepo.findById = async () => null;
  eclient.submitWarranty = async () => ({ ok: false, status: 422, data: { errors: [] }, networkError: false });
  try {
    await syncSvc.syncWarrantyForm({ getConnection: async () => ({ release() {} }) }, 77); // must not throw
  } finally {
    Object.assign(wrepo, { findDetailById: orig.fd, updateEasyGasSyncResult: orig.up });
    erepo.findByWarrantyFormIds = orig.eq; crepo.findById = orig.car; eclient.submitWarranty = orig.submit;
  }
  assert.equal(recorded.result, 'FAILED');
  assert.equal(recorded.claimUrl, null);
});

// ══ Part 23 — update / remove ══
const update = (equipment) => warrantyService.updateWarrantyForm(conn, 77, 9, 'ADMIN', { equipment });

test('23.30/31/32 removing an existing cylinder deletes exactly that row, keeps the other 3, reverses its points once (reverse BEFORE delete)', async () => {
  state.existingRows = [stored('REDUCER'), stored('CYLINDER'), stored('CONTROLLER'), stored('INJECTOR_RAIL')];
  const order = [];
  const origReverse = pointsService.reverseForEquipmentRow;
  const origDelete = erepo.deleteByFormAndType;
  pointsService.reverseForEquipmentRow = async (_c, args) => { order.push('reverse'); state.reversals.push(args); };
  erepo.deleteByFormAndType = async (_c, formId, type) => { order.push('delete'); state.deleted.push({ formId, type }); return 1; };
  try {
    await update(THREE());
  } finally {
    pointsService.reverseForEquipmentRow = origReverse;
    erepo.deleteByFormAndType = origDelete;
  }
  assert.deepEqual(state.deleted, [{ formId: 77, type: 'CYLINDER' }]);
  assert.equal(state.reversals.length, 1);
  assert.equal(state.reversals[0].warrantyEquipmentId, 202); // the cylinder row
  assert.deepEqual(order, ['reverse', 'delete']); // FK is ON DELETE SET NULL — must reverse first
  assert.equal(state.upserted.length, 3);
  assert.ok(!state.upserted.some((r2) => r2.equipment_type === 'CYLINDER'));
  assert.equal(state.awards.length, 0); // unchanged rows re-award nothing
});

test('23.33 removing again (already absent) is a no-op — no delete, no double reversal', async () => {
  state.existingRows = [stored('REDUCER'), stored('CONTROLLER'), stored('INJECTOR_RAIL')];
  await update(THREE());
  assert.equal(state.deleted.length, 0);
  assert.equal(state.reversals.length, 0);
});

test('23.34/35 adding a cylinder to a no-cylinder warranty creates the row and awards its points exactly once', async () => {
  state.existingRows = [stored('REDUCER'), stored('CONTROLLER'), stored('INJECTOR_RAIL')];
  const afterRows = [stored('REDUCER'), stored('CYLINDER'), stored('CONTROLLER'), stored('INJECTOR_RAIL')];
  let call = 0;
  erepo.findByWarrantyFormIds = async () => (call++ === 0 ? state.existingRows.map((r2) => ({ ...r2 })) : afterRows.map((r2) => ({ ...r2 })));
  try {
    await update([R(), CYL(), C(), I()]);
  } finally {
    erepo.findByWarrantyFormIds = async () => state.existingRows.map((r2) => ({ ...r2 }));
  }
  assert.equal(state.deleted.length, 0);
  assert.equal(state.upserted.length, 4);
  assert.equal(state.awards.length, 1);
  assert.equal(state.awards[0].equipmentType, 'CYLINDER');
});

test('23.36 catalog → typed cylinder transition reverses and re-awards that one row', async () => {
  state.existingRows = [stored('REDUCER'), stored('CYLINDER'), stored('CONTROLLER'), stored('INJECTOR_RAIL')];
  const afterRows = [stored('REDUCER'), stored('CYLINDER', { product_id: null, brand_name: 'GZWM', model: '60L' }), stored('CONTROLLER'), stored('INJECTOR_RAIL')];
  let call = 0;
  erepo.findByWarrantyFormIds = async () => (call++ === 0 ? state.existingRows.map((r2) => ({ ...r2 })) : afterRows.map((r2) => ({ ...r2 })));
  try {
    await update([R(), { equipment_type: 'CYLINDER', product_id: null, brand_name: 'GZWM', model: '60L', serial_number: 'SC-4' }, C(), I()]);
  } finally {
    erepo.findByWarrantyFormIds = async () => state.existingRows.map((r2) => ({ ...r2 }));
  }
  assert.equal(state.deleted.length, 0); // transition, not removal
  assert.equal(state.reversals.length, 1);
  assert.equal(state.awards.length, 1);
});

test('23.37 typed → no-cylinder removes the typed row safely (reverse + delete)', async () => {
  state.existingRows = [stored('REDUCER'), stored('CYLINDER', { product_id: null, brand_name: 'GZWM', model: '60L' }), stored('CONTROLLER'), stored('INJECTOR_RAIL')];
  await update(THREE());
  assert.deepEqual(state.deleted, [{ formId: 77, type: 'CYLINDER' }]);
  assert.equal(state.reversals.length, 1);
});

test('23.38 a failure AFTER removal rolls the transaction back (reverse+delete live inside the same locked tx)', async () => {
  state.existingRows = [stored('REDUCER'), stored('CYLINDER'), stored('CONTROLLER'), stored('INJECTOR_RAIL')];
  state.upsertShouldThrow = true;
  await assert.rejects(() => update(THREE()));
  assert.equal(state.rollbacks, 1); // the real DB then discards the DELETE and the reversal insert together
  assert.equal(state.commits, 0);
});

// ══ Part 24 — read / export ══
const modernNoCyl = () => ({
  ...FORM_ROW, status: 'SUCCESSFUL', created_at: '2026-09-01T10:00:00Z', easygas_sync_result: 'SUCCESS',
  easygas_claim_url: 'https://gasgo.uz/w/x', reviewed_at: null, review_notes: null, reviewed_by_name: null,
  vehicle_name: 'CHEVROLET Cobalt',
  equipment: [
    { equipment_type: 'REDUCER', product_name: 'Red X', serial_number: 'R1' },
    { equipment_type: 'CONTROLLER', product_name: 'Ctrl Y', serial_number: 'K1' },
    { equipment_type: 'INJECTOR_RAIL', product_name: 'Rail Z', serial_number: 'I1' },
  ],
});

test('24.39 full DTO handles a 3-equipment warranty (no legacy fallback triggered, no crash)', () => {
  const dto = toWarrantyResponse(modernNoCyl());
  assert.equal(dto.equipment.length, 3);
  assert.equal(dto.legacy_equipment, null);
});

test('24.41 customer-lookup safe DTO handles absent cylinder', () => {
  const [item] = toWarrantyLookupResponse([modernNoCyl()]);
  assert.equal(item.equipment.length, 3);
  assert.ok(!item.equipment.some((e) => e.equipment_type === 'CYLINDER'));
  assert.equal(item.legacy_equipment, null);
});

test('24.43/44/45 CSV: absent cylinder yields EMPTY cylinder columns (no NULL/N-A text) and controller columns stay in place', () => {
  const labels = getLabels('uz');
  const columns = buildWarrantyColumns(labels, 'uz');
  const val = (key) => columns.find((c2) => c2.header === labels.columns[key]).value(modernNoCyl());
  assert.equal(val('cylinderProduct'), '');
  assert.equal(val('cylinderSerial'), '');
  assert.equal(val('controllerProduct'), 'Ctrl Y');
  assert.equal(val('controllerSerial'), 'K1');
  assert.equal(val('reducerProduct'), 'Red X');
  assert.equal(val('injectorRailProduct'), 'Rail Z');
});
