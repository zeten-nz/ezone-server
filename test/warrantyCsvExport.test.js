/**
 * Warranty CSV export (§14). node:test, no DB. Verifies the full column set (per-equipment product+serial columns,
 * installer/vehicle/owner/status/EasyGas/review), the normalized→legacy fallback, the streaming keyset loop, batched
 * equipment enrichment (no N+1), preserved filters, and the centralized CSV escaping / formula-injection guard.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getLabels } = require('../config/csvLabels');
const { buildWarrantyColumns } = require('../utils/warrantyCsvColumns');
const { escapeCsvField, streamRowsAsCsv } = require('../utils/csvStream');
const { attachEquipment } = require('../utils/warrantyEquipment');

const labels = getLabels('uz');
const columns = buildWarrantyColumns(labels, 'uz');
const val = (form, key) => columns.find((c) => c.header === labels.columns[key]).value(form);

const modernForm = {
  id: 1, warranty_book_number: 'W-2026-000001', status: 'SUCCESSFUL',
  created_at: new Date('2026-08-26T10:00:00Z'), installation_date: '2026-08-20',
  installer_full_name: 'John Installer', installer_phone: '+998901112233',
  installer_region: 'Tashkent', city: 'Tashkent City', installer_district: 'Yunusabad',
  installer_branch: 'Central Branch', installer_branch_code: 'BR-01', organization_phone: '+998907776655',
  owner_full_name: 'Owner Name', owner_phone: '+998901234567',
  vehicle_name: 'Chevrolet Cobalt', vehicle_production_year: 2020, vehicle_plate_number: '01A123BC',
  vehicle_vin: 'VIN123', vehicle_mileage: 45000, fuel_type: 'LPG',
  easygas_sync_result: 'SUCCESS', easygas_claim_url: 'https://easygas.uz/w/abc',
  reviewed_at: new Date('2026-08-25T09:00:00Z'), review_notes: 'ok', reviewed_by_name: 'Admin A',
  equipment: [
    { equipment_type: 'REDUCER', product_name: 'Reducer X', serial_number: 'R1' },
    { equipment_type: 'CYLINDER', product_name: 'Cyl Y', serial_number: 'C1' },
    { equipment_type: 'CONTROLLER', product_name: 'ADAX DG7', serial_number: 'K1' },
    { equipment_type: 'INJECTOR_RAIL', product_name: 'Rail Z', serial_number: 'I1' },
  ],
};

test('§14.14 exports all four equipment products in their own columns', () => {
  assert.equal(val(modernForm, 'reducerProduct'), 'Reducer X');
  assert.equal(val(modernForm, 'cylinderProduct'), 'Cyl Y');
  assert.equal(val(modernForm, 'controllerProduct'), 'ADAX DG7');
  assert.equal(val(modernForm, 'injectorRailProduct'), 'Rail Z');
});

test('§14.15 exports all four serials in the correct columns', () => {
  assert.equal(val(modernForm, 'reducerSerial'), 'R1');
  assert.equal(val(modernForm, 'cylinderSerial'), 'C1');
  assert.equal(val(modernForm, 'controllerSerial'), 'K1');
  assert.equal(val(modernForm, 'injectorRailSerial'), 'I1');
});

test('§14.16 typed cylinder (no product_id) resolves brand+model as the product label', () => {
  const typed = { ...modernForm, equipment: [{ equipment_type: 'CYLINDER', product_id: null, product_name: '', brand_name: 'CustomBrand', model: 'CM1', serial_number: 'C9' }] };
  assert.equal(val(typed, 'cylinderProduct'), 'CustomBrand CM1');
  assert.equal(val(typed, 'cylinderSerial'), 'C9');
});

test('§14.17 legacy equipment fallback for historical rows (no normalized equipment)', () => {
  const legacy = {
    ...modernForm, equipment: [],
    reducer_manufacturer: 'Old Reducer', reducer_serial_number: 'OR1',
    stag_controller_manufacturer: 'Old STAG', stag_controller_serial_number: 'OK1',
    injector_rail_manufacturer: 'Old Rail', injector_rail_serial_number: 'OI1',
    cylinder_manufacturer: 'Old Cyl', cylinder_serial_number: 'OC1',
  };
  assert.equal(val(legacy, 'reducerProduct'), 'Old Reducer');
  assert.equal(val(legacy, 'reducerSerial'), 'OR1');
  assert.equal(val(legacy, 'controllerProduct'), 'Old STAG'); // stag_controller_* → CONTROLLER slot
  assert.equal(val(legacy, 'controllerSerial'), 'OK1');
  assert.equal(val(legacy, 'injectorRailProduct'), 'Old Rail');
  assert.equal(val(legacy, 'cylinderProduct'), 'Old Cyl');
});

test('§14.18 installer/branch snapshot exported', () => {
  assert.equal(val(modernForm, 'installerFullName'), 'John Installer');
  assert.equal(val(modernForm, 'installerPhone'), '+998901112233');
  assert.equal(val(modernForm, 'region'), 'Tashkent');
  assert.equal(val(modernForm, 'city'), 'Tashkent City');
  assert.equal(val(modernForm, 'district'), 'Yunusabad');
  assert.equal(val(modernForm, 'branchName'), 'Central Branch');
  assert.equal(val(modernForm, 'branchCode'), 'BR-01');
  assert.equal(val(modernForm, 'orgPhone'), '+998907776655');
});

test('§14.19 vehicle fields exported (name via resolveVehicleName)', () => {
  assert.equal(val(modernForm, 'vehicle'), 'Chevrolet Cobalt');
  assert.equal(val(modernForm, 'productionYear'), 2020);
  assert.equal(val(modernForm, 'plateNumber'), '01A123BC');
  assert.equal(val(modernForm, 'vin'), 'VIN123');
  assert.equal(val(modernForm, 'mileage'), 45000);
  assert.equal(val(modernForm, 'fuelType'), 'LPG');
  // legacy vehicle: brand+model fallback
  assert.equal(val({ ...modernForm, vehicle_name: null, vehicle_brand: 'Daewoo', vehicle_model: 'Nexia' }, 'vehicle'), 'Daewoo Nexia');
});

test('§14.20 owner fields exported', () => {
  assert.equal(val(modernForm, 'ownerName'), 'Owner Name');
  assert.equal(val(modernForm, 'ownerPhone'), '+998901234567');
});

test('§14.21 warranty status exported (localized)', () => {
  assert.equal(val(modernForm, 'warrantyStatus'), labels.warrantyStatuses.SUCCESSFUL); // 'Tasdiqlangan'
  assert.equal(val({ ...modernForm, status: 'REJECTED' }, 'warrantyStatus'), labels.warrantyStatuses.REJECTED);
});

test('§14.22 EasyGas sync result exported (localized)', () => {
  assert.equal(val(modernForm, 'easyGasSyncResult'), labels.easyGasSyncResults.SUCCESS); // 'Muvaffaqiyatli'
  assert.equal(val({ ...modernForm, easygas_sync_result: 'FAILED' }, 'easyGasSyncResult'), labels.easyGasSyncResults.FAILED);
});

test('§14.23 claim_url exported verbatim', () => {
  assert.equal(val(modernForm, 'easyGasClaimUrl'), 'https://easygas.uz/w/abc');
});

test('§14.24 streamRowsAsCsv streams multiple keyset chunks in id order', async () => {
  const all = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }];
  const cols = [{ header: 'ID', value: (r) => r.id }, { header: 'N', value: (r) => r.name }];
  const seen = [];
  const fetchChunk = async (lastId, limit) => { seen.push(lastId); return all.filter((r) => r.id > lastId).slice(0, limit); };
  const written = [];
  const res = { setHeader() {}, write: (s) => written.push(s), end() {} };
  await streamRowsAsCsv(res, { filename: 'x.csv', columns: cols, fetchChunk, chunkSize: 2 });
  const body = written.join('');
  assert.match(body, /ID,N/);
  assert.ok(body.includes('1,a') && body.includes('2,b') && body.includes('3,c'));
  assert.deepEqual(seen, [0, 2]); // keyset cursor advanced by the last id of each chunk
});

test('§14.25 equipment enrichment is ONE batched query per chunk (no N+1)', async () => {
  let execCount = 0;
  const conn = { execute: async () => { execCount++; return [[
    { warranty_form_id: 1, equipment_type: 'REDUCER', product_name: 'R', serial_number: 'r1' },
    { warranty_form_id: 2, equipment_type: 'CYLINDER', product_name: 'C', serial_number: 'c1' },
  ]]; } };
  const enriched = await attachEquipment(conn, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(execCount, 1); // one findByWarrantyFormIds for the whole chunk, not per-form
  assert.equal(enriched[0].equipment.length, 1);
  assert.equal(enriched[2].equipment.length, 0); // form with no equipment → empty array, not a failed lookup
});

test('§14.26 findChunkForExport preserves filters + keyset order + reviewer join', async () => {
  const warrantyRepo = require('../repositories/warrantyRepository');
  let captured;
  const conn = { execute: async (sql, params) => { captured = { sql, params }; return [[]]; } };
  await warrantyRepo.findChunkForExport(conn, { lastId: 5, limit: 100, employeeId: 9, search: 'ABC', verificationStatus: 'PENDING' });
  assert.match(captured.sql, /wf\.id > \?/);
  assert.match(captured.sql, /ORDER BY wf\.id ASC/);
  assert.match(captured.sql, /LEFT JOIN users ru ON ru\.id = wf\.reviewed_by/);
  assert.match(captured.sql, /reviewed_by_name/);
  assert.match(captured.sql, /wf\.employee_id = \?/);
  assert.match(captured.sql, /verification_status = \?/);
  assert.ok(captured.params.includes(9) && captured.params.includes('PENDING') && captured.params.includes('%ABC%'));
});

test('§14.27 CSV escaping: commas, quotes, newlines, null', () => {
  assert.equal(escapeCsvField('plain'), 'plain');
  assert.equal(escapeCsvField('a,b'), '"a,b"');
  assert.equal(escapeCsvField('he said "hi"'), '"he said ""hi"""');
  assert.equal(escapeCsvField('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCsvField(null), '');
  assert.equal(escapeCsvField(undefined), '');
});

test('§14.28 CSV formula-injection neutralized (= + - @ prefixed), legit values intact', () => {
  assert.equal(escapeCsvField('=1+1'), "'=1+1");
  assert.equal(escapeCsvField('+998901234567'), "'+998901234567");
  assert.equal(escapeCsvField('-5'), "'-5");
  assert.equal(escapeCsvField('@cmd'), "'@cmd");
  assert.equal(escapeCsvField('SAFE-text'), 'SAFE-text'); // '-' only triggers at position 0
  assert.equal(escapeCsvField(2020), '2020'); // numeric field untouched
});

test('column set has no gaps and headers are unique', () => {
  assert.equal(columns.length, 34); // general 5 + installer 8 + owner 2 + vehicle 6 + equipment 8 + easygas 2 + review 3
  assert.equal(new Set(columns.map((c) => c.header)).size, columns.length);
});
