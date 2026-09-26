const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const fs = require('node:fs');
const { mapClientWarranty, vehicleParts, excelDate } = require('../utils/clientWarrantyExcelMapper');
const { createClientWarrantyWorkbook, appendClientWarranty } = require('../utils/clientWarrantyWorkbook');
const layout = require('../config/clientWarrantyLayout.json');

const fixture = {
  id: 987, installer_branch_code: '001/2', installer_region: 'Test region', city: 'Test city',
  installer_district: 'Test district', installer_branch: 'Test branch', owner_phone: '+998000000001',
  owner_full_name: 'Synthetic Owner', warranty_book_number: 'TEST-0001', installation_date: '2026-09-20',
  car_id: 4, catalog_car: { brand: 'Catalog', model: 'Test model' }, vehicle_name: 'Other Name',
  vehicle_production_year: 2021, vehicle_plate_number: '001TEST', vehicle_vin: '00012345678901234',
  vehicle_engine_volume: null, vehicle_engine_power: null, vehicle_mileage: 0,
  installer_full_name: 'Synthetic Installer', installer_phone: '+998000000002', fuel_type: 'LPG',
  equipment: ['REDUCER', 'CYLINDER', 'CONTROLLER', 'INJECTOR_RAIL'].map((equipment_type, i) => ({
    equipment_type, product_id: i + 1, product_brand: `Brand ${i}`, product_name: 'Do not use full label',
    product_brand_country: 'Poland', serial_number: `000${i}`,
  })),
};

test('maps every column A:AH using authoritative fields, preserving actual zero and blank engines', () => {
  assert.deepEqual(Object.values(mapClientWarranty(fixture)), [
    '', '001/2', 'Test region', 'Test city', 'Test district', 'Test branch', '+998000000001', 'Synthetic Owner',
    'TEST-0001', new Date('2026-09-20T00:00:00Z'), 'Catalog', 'Test model', '2021', '001TEST', '00012345678901234',
    '', '', '0', 'Synthetic Installer', '+998000000002', 'LPG', 'Brand 0', 'Poland', '0000',
    'LPG', 'Brand 1', 'Poland', '0001', 'Brand 2', 'Poland', '0002', 'Brand 3', 'Poland', '0003',
  ]);
  const old = mapClientWarranty({ vehicle_engine_volume: '1.5', vehicle_engine_power: 95 });
  assert.equal(old.P, '1.5'); assert.equal(old.Q, '95');
});

test('vehicle catalog, complete legacy pair, normalized free text, and unknown rules', () => {
  assert.deepEqual(vehicleParts(fixture), ['Catalog', 'Test model']);
  assert.deepEqual(vehicleParts({ vehicle_brand: 'Legacy', vehicle_model: 'Model', vehicle_name: 'Other Name' }), ['Legacy', 'Model']);
  assert.deepEqual(vehicleParts({ vehicle_name: '  CHEVROLET   Cobalt 1.5 ' }), ['CHEVROLET', 'Cobalt 1.5']);
  assert.deepEqual(vehicleParts({ vehicle_brand: 'Partial', vehicle_name: 'Unresolved' }), ['', '']);
  assert.deepEqual(vehicleParts({}), ['', '']);
});

test('typed cylinder, legacy equipment and absent cylinder never invent country or placeholders', () => {
  const typed = mapClientWarranty({ fuel_type: 'CNG', equipment: [{ equipment_type: 'CYLINDER', brand_name: 'Typed', serial_number: 'A,B', product_brand_country: 'Ignore unlinked country' }] });
  assert.deepEqual([typed.Y, typed.Z, typed.AA, typed.AB], ['CNG', 'Typed', '', 'A, B']);
  const old = mapClientWarranty({ reducer_manufacturer: 'Legacy', reducer_serial_number: '01', stag_controller_manufacturer: 'Old ECU', injector_rail_serial_number: '02' });
  assert.deepEqual([old.V, old.W, old.X, old.AC, old.AH], ['Legacy', '', '01', 'Old ECU', '02']);
  assert.deepEqual([old.Y, old.Z, old.AA, old.AB], ['', '', '', '']);
});

test('retains 12 injector and many cylinder serials in fixed cells for both representations', () => {
  const serials = Array.from({ length: 40 }, (_, i) => `000${i}`);
  const mapped = mapClientWarranty({ equipment: [
    { equipment_type: 'CYLINDER', serial_numbers: serials },
    { equipment_type: 'INJECTOR_RAIL', serial_number: serials.slice(0, 12).join(',') },
  ] });
  assert.equal(mapped.AB, serials.join(', '));
  assert.equal(mapped.AH, serials.slice(0, 12).join(', '));
  assert.equal(Object.keys(mapped).length, 34);
});

test('dates preserve calendar meaning and reject invalid values', () => {
  assert.equal(excelDate('2026-02-30'), null);
  assert.equal(excelDate('invalid'), null);
  assert.equal(excelDate(new Date('2026-09-20T00:00:00Z')).toISOString(), '2026-09-20T00:00:00.000Z');
});

test('values beyond Excel cell capacity are rejected explicitly instead of silently losing serials', () => {
  const sheet = createClientWarrantyWorkbook().worksheets[0];
  assert.throws(() => appendClientWarranty(sheet, { id: 1, equipment: [{ equipment_type: 'CYLINDER', serial_number: 'A'.repeat(32768) }] }), { statusCode: 422 });
  assert.equal(sheet.rowCount, 3);
});

test('XLSX roundtrip: exact bilingual headers, 34 columns, dates, styles, literal text and blanks', async () => {
  const workbook = createClientWarrantyWorkbook();
  appendClientWarranty(workbook.worksheets[0], fixture);
  for (const value of ['=1+1', '+1+1', '-1+1', '@SUM(A1)', '0000000000000000000000001']) {
    appendClientWarranty(workbook.worksheets[0], { owner_full_name: value, equipment: [{ equipment_type: 'REDUCER', serial_number: value }] });
  }
  const loaded = await new ExcelJS.Workbook().xlsx.load(await workbook.xlsx.writeBuffer());
  assert.equal(loaded.worksheets.length, 1);
  const s = loaded.worksheets[0];
  assert.equal(s.name, 'Kafolat'); assert.equal(s.columnCount, 34);
  assert.equal(s.getCell('B1').value, 'Kafolat reyestri');
  assert.deepEqual(s.getRow(2).values.slice(1), layout.ru);
  assert.deepEqual(s.getRow(3).values.slice(1), layout.uz);
  assert.equal(s.getCell('A2').value, 'RUS'); assert.equal(s.getCell('A3').value, "O'zbek");
  for (const [col, value] of Object.entries(mapClientWarranty(fixture))) assert.deepEqual(s.getCell(`${col}4`).value, value === '' ? null : value);
  assert.equal(s.getCell('J4').numFmt, 'dd/mm/yyyy');
  assert.equal(s.getCell('G4').numFmt, '@');
  assert.equal(s.views[0].ySplit, 3);
  assert.equal(s.getCell('B2').alignment.wrapText, true);
  assert.equal(s.getCell('AH4').border.bottom.style, 'thin');
  for (let r = 5; r <= 9; r++) {
    assert.equal(s.getCell(`H${r}`).type, ExcelJS.ValueType.String);
    assert.equal(s.getCell(`H${r}`).formula, undefined);
    assert.equal(s.getCell(`H${r}`).value, s.getCell(`X${r}`).value);
  }
});

test('batched repository uses catalog joins and the shared filter query, including missing car fallback', async () => {
  const calls = [];
  const connection = { execute: async (sql, params) => {
    calls.push({ sql, params });
    if (calls.length === 1) return [[{ id: 1, car_id: 4 }, { id: 2, car_id: 99 }]];
    if (calls.length === 2) return [[{ warranty_form_id: 1, equipment_type: 'REDUCER', product_id: 1, product_brand_country: 'Poland' }]];
    return [[{ id: 4, brand: 'Catalog', model: 'Model' }]];
  } };
  const forms = await require('../repositories/clientWarrantyExportRepository').findChunk(connection, { lastId: 0, limit: 500, employeeId: 7, search: 'query', verificationStatus: 'PENDING' });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].params, [0, 7, 'PENDING', '%query%', '%query%', '%query%']);
  assert.match(calls[1].sql, /LEFT JOIN brands b ON b.id = p.brand_id/);
  assert.deepEqual(calls[1].params, [1, 2]); assert.deepEqual(calls[2].params, [4, 99]);
  assert.equal(forms[0].catalog_car.brand, 'Catalog'); assert.equal(forms[1].catalog_car, undefined);
  assert.equal(forms[0].equipment[0].product_brand_country, 'Poland');
});

test('route is guarded by authentication and ADMIN authorization', () => {
  const server = fs.readFileSync(require.resolve('../server'), 'utf8');
  assert.match(server, /app.get\('\/api\/export\/client-warranty\.xlsx', verifyToken, authorizeRole\('ADMIN'\)/);
});

test('HTTP export rejects anonymous/employee requests, passes filters, downloads XLSX and releases on failure', async () => {
  const dbPath = require.resolve('../config/database');
  const previous = require.cache[dbPath];
  let role = 'ADMIN';
  let released = 0;
  let fail = false;
  const calls = [];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: {
    execute: async () => [[{ is_active: 1, role }]],
    getConnection: async () => ({ release: () => released++, execute: async (sql, params) => {
      if (fail) throw new Error('Synthetic database failure');
      calls.push({ sql, params });
      if (sql.includes('FROM warranty_forms') && params[0] === 0) return [[{ ...fixture, equipment: undefined, catalog_car: undefined }]];
      return [[]];
    } }),
  } } };
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'synthetic-export-test-secret';
  const express = require('express');
  const { verifyToken, authorizeRole } = require('../middleware/auth');
  const { exportClientWarranty } = require('../controllers/clientWarrantyExportController');
  const app = express();
  app.get('/export', verifyToken, authorizeRole('ADMIN'), exportClientWarranty);
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/export?employeeId=7&search=%20query%20&verificationStatus=PENDING`;
  const headers = { Authorization: `Bearer ${require('jsonwebtoken').sign({ id: 1 }, process.env.JWT_SECRET)}` };
  try {
    assert.equal((await fetch(url)).status, 401);
    role = 'EMPLOYEE'; assert.equal((await fetch(url, { headers })).status, 403);
    assert.equal(calls.length, 0);
    role = 'ADMIN';
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /client_warranty_.*\.xlsx/);
    assert.match(response.headers.get('content-type'), /spreadsheetml/);
    const workbook = await new ExcelJS.Workbook().xlsx.load(Buffer.from(await response.arrayBuffer()));
    assert.equal(workbook.worksheets[0].getCell('B4').value, fixture.installer_branch_code);
    assert.deepEqual(calls[0].params, [0, 7, 'PENDING', '%query%', '%query%', '%query%']);
    assert.equal(calls.at(-1).params[0], fixture.id);
    assert.equal(released, 1);
    fail = true; assert.equal((await fetch(url, { headers })).status, 500);
    assert.equal(released, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous) require.cache[dbPath] = previous; else delete require.cache[dbPath];
    if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
  }
});
