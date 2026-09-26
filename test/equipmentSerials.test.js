const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const serials = require('../utils/equipmentSerials');
const { EQUIPMENT_SERIAL_RULES, SERIAL_MAX_LENGTH, SERIAL_STORAGE_MAX_BYTES } = require('../config/equipmentSerialRules');
const service = require('../services/warrantyService');
const wr = require('../repositories/warrantyRepository');
const er = require('../repositories/equipmentRepository');
const pr = require('../repositories/productRepository');
const points = require('../services/pointsService');
const { buildPayload } = require('../services/easyGasWarrantySyncService');
const { toWarrantyResponse, toWarrantyLookupResponse } = require('../dtos/warrantyDTO');
const { writeCsvRow } = require('../utils/csvStream');
const { buildWarrantyColumns } = require('../utils/warrantyCsvColumns');
const { getLabels } = require('../config/csvLabels');
const { ensureEquipmentSerialText } = require('../config/database');

const fetch = global.fetch;
global.fetch = () => { throw new Error('External network forbidden'); };
after(() => { global.fetch = fetch; });
const values = (count) => Array.from({ length: count }, (_, index) => `SN${index + 1}`);
const row = (equipment_type, count = 1) => ({ equipment_type, product_id: 1, serial_numbers: values(count) });
const required = () => ['REDUCER', 'CONTROLLER', 'INJECTOR_RAIL'].map((type) => row(type));

test('canonical parse, normalize and serialize, including legacy single serial', () => {
  assert.deepEqual(serials.parseSerialNumbers('A'), ['A']);
  assert.deepEqual(serials.parseSerialNumbers('A,B,C'), ['A', 'B', 'C']);
  assert.deepEqual(serials.normalizeSerialNumbers([' A ', 'B']), ['A', 'B']);
  assert.equal(serials.serializeSerialNumbers(['A', 'B', 'C']), 'A,B,C');
  assert.equal(serials.serializeSerialNumbers(['A / B-01']), 'A / B-01');
});
for (const [input, error] of [
  [['A', ' A '], 'SERIAL_DUPLICATE'], [['A', ''], 'SERIAL_EMPTY'],
  [['A,B'], 'SERIAL_COMMA_NOT_ALLOWED'], [[null], 'SERIAL_STRING_REQUIRED'],
  [[123], 'SERIAL_STRING_REQUIRED'], [['x'.repeat(151)], 'SERIAL_TOO_LONG'],
  ['ABC', 'SERIAL_ARRAY_REQUIRED'],
]) test(`normalization refuses ${error}`, () => assert.throws(() => serials.normalizeSerialNumbers(input), { errorCode: error }));

test('TEXT byte protection is independent of count and never truncates', () => {
  assert.equal(SERIAL_MAX_LENGTH, 150);
  assert.equal(SERIAL_STORAGE_MAX_BYTES, 65535);
  assert.throws(() => serials.serializeSerialNumbers(Array.from({ length: 150 }, (_, i) => '界'.repeat(148) + i)), { errorCode: 'SERIAL_TOO_LONG' });
  assert.throws(() => serials.serializeSerialNumbers(Array.from({ length: 200 }, (_, i) => '界'.repeat(140) + i)), { errorCode: 'SERIAL_STORAGE_TOO_LONG' });
});

function setup(t) {
  const state = { rows: [], deleted: false, commits: 0, rollback: 0, inserts: 0 };
  const conn = { beginTransaction: async () => {}, commit: async () => { state.commits++; }, rollback: async () => { state.rollback++; } };
  t.mock.method(wr, 'getEmployeeSnapshot', async () => ({ branch_code: '01/1' }));
  t.mock.method(wr, 'findBySubmissionUuid', async () => null);
  t.mock.method(wr, 'getNextWarrantyNumber', async () => 'LPG-26-000010');
  t.mock.method(wr, 'insert', async () => { state.inserts++; return 42; });
  t.mock.method(wr, 'findOwnershipInfo', async () => ({ employee_id: 7, created_at: new Date() }));
  t.mock.method(wr, 'lockForm', async () => ({ id: 42 }));
  t.mock.method(wr, 'update', async () => {});
  t.mock.method(wr, 'deleteById', async () => { state.deleted = true; });
  t.mock.method(pr, 'findById', async (_c, id) => ({ id, brand: 'STAG', model: 'X', is_active: true }));
  t.mock.method(er, 'findByWarrantyFormIds', async () => state.rows);
  t.mock.method(er, 'upsertMany', async (_c, _id, rows) => { state.rows = rows.map((r, i) => ({ ...r, id: i + 1 })); });
  t.mock.method(er, 'deleteByFormAndType', async (_c, _id, type) => { state.rows = state.rows.filter((r) => r.equipment_type !== type); });
  t.mock.method(points, 'awardForEquipmentRow', () => assert.fail('Warranty must not award points'));
  t.mock.method(points, 'reverseForEquipmentRow', () => assert.fail('Warranty must not reverse points'));
  const create = (equipment) => service.createWarrantyForm(conn, 7, { equipment, submission_uuid: 'same-uuid', fuel_type: 'LPG' });
  const update = (equipment) => service.updateWarrantyForm(conn, 42, 7, 'EMPLOYEE', { equipment });
  return { state, conn, create, update };
}

test('old-client single string creates successfully, with zero points', async (t) => {
  const f = setup(t);
  await f.create(required().map(({ serial_numbers, ...r }) => ({ ...r, serial_number: serial_numbers[0] })));
  assert.ok(f.state.rows.every((r) => r.serial_number === 'SN1'));
  assert.equal(f.state.rows.length, 3);
});

for (const [type, count, accepted] of [
  ['REDUCER', 2, false], ['CONTROLLER', 2, false], ['INJECTOR_RAIL', 0, false],
  ['INJECTOR_RAIL', 1, true], ['INJECTOR_RAIL', 12, true], ['INJECTOR_RAIL', 13, false],
  ['CYLINDER', 0, false], ['CYLINDER', 1, true], ['CYLINDER', 4, true],
  ['CYLINDER', 8, true], ['CYLINDER', 12, true], ['CYLINDER', 40, true],
]) test(`create ${type} with ${count} serials: ${accepted ? 'accepted' : 'rejected'}`, async (t) => {
  const f = setup(t);
  const rows = [...required().filter((r) => r.equipment_type !== type), row(type, count)];
  if (accepted) {
    await f.create(rows);
    assert.equal(f.state.rows.find((r) => r.equipment_type === type).serial_number, values(count).join(','));
    assert.equal(f.state.rows.filter((r) => r.equipment_type === type).length, 1);
  } else {
    await assert.rejects(f.create(rows), { errorCode: 'SERIAL_COUNT_INVALID' });
    assert.equal(f.state.inserts, 0);
  }
});

test('service enforces duplicate/empty/shape errors even without route validation', async (t) => {
  const f = setup(t);
  for (const serial_numbers of [['A', ' A '], ['A', ''], ['A,B'], [123], null, 'A']) {
    await assert.rejects(f.create([...required().slice(0, 2), { ...row('INJECTOR_RAIL'), serial_numbers }]));
  }
  assert.equal(f.state.inserts, 0);
});

test('single/multiple/fewer/one injector edits and cylinder 4/8/remove/re-add leave no stale serials or points', async (t) => {
  const f = setup(t);
  await f.create(required());
  for (const count of [4, 2, 1]) {
    await f.update([...required().slice(0, 2), row('INJECTOR_RAIL', count)]);
    assert.equal(f.state.rows.find((r) => r.equipment_type === 'INJECTOR_RAIL').serial_number, values(count).join(','));
  }
  for (const count of [4, 8, 0, 2]) {
    await f.update([...required(), ...(count ? [row('CYLINDER', count)] : [])]);
    assert.equal(f.state.rows.find((r) => r.equipment_type === 'CYLINDER')?.serial_number, count ? values(count).join(',') : undefined);
  }
  await f.update(required().map((r) => ({ ...r, product_id: 99 })));
  await service.deleteWarrantyForm(f.conn, 42, 7);
  assert.equal(f.state.deleted, true);
});

test('historical approval never awards points', async (t) => {
  const f = setup(t);
  t.mock.method(er, 'findById', async () => ({ id: 1, warranty_form_id: 42 }));
  t.mock.method(er, 'reviewVerification', async () => true);
  await service.reviewManualVerification(f.conn, 1, 7, { decision: 'APPROVED' });
});

test('employee edit ownership/time window remain enforced', async (t) => {
  const f = setup(t);
  await assert.rejects(service.updateWarrantyForm(f.conn, 42, 8, 'EMPLOYEE', { equipment: required() }), { errorCode: 'FORBIDDEN' });
  t.mock.method(wr, 'findOwnershipInfo', async () => ({ employee_id: 7, created_at: '2020-01-01' }));
  await assert.rejects(f.update(required()), { errorCode: 'EDIT_WINDOW_EXPIRED' });
  await service.updateWarrantyForm(f.conn, 42, 8, 'ADMIN', { equipment: required() });
});

test('EasyGas emits one component per type, canonical serial list, and unchanged absent-cylinder object', async (t) => {
  const f = setup(t);
  await f.create([...required().slice(0, 2), row('INJECTOR_RAIL', 4), row('CYLINDER', 3)]);
  const vehicle = { carId: 123, vehicleBrand: null, vehicleModel: null };
  const payload = buildPayload({ id: 42 }, f.state.rows, vehicle);
  assert.equal(payload.components.length, 4);
  for (const [type, count] of [['injector', 4], ['cylinder', 3]]) {
    const components = payload.components.filter((c) => c.component_type === type);
    assert.equal(components.length, 1);
    assert.equal(components[0].serial_number, values(count).join(','));
  }
  await f.update(required());
  assert.deepEqual(buildPayload({ id: 42 }, f.state.rows, vehicle).components.find((c) => c.component_type === 'cylinder'), {
    component_type: 'cylinder', serial_number: null, product_id: null, brand_name: null, model: null,
  });
});

test('full and safe lookup DTOs expose serial arrays and retain compatibility string', () => {
  for (const value of ['A', 'A,B,C']) {
    const input = { equipment: [{ equipment_type: 'INJECTOR_RAIL', serial_number: value, inventory_item_id: 999 }] };
    for (const dto of [toWarrantyResponse(input), toWarrantyLookupResponse([input])[0]]) {
      assert.equal(dto.equipment[0].serial_number, value);
      assert.deepEqual(dto.equipment[0].serial_numbers, value.split(','));
    }
    assert.equal('inventory_item_id' in toWarrantyLookupResponse([input])[0].equipment[0], false);
  }
});

test('CSV quotes a multi-serial field as one column', () => {
  const columns = buildWarrantyColumns(getLabels('uz'), 'uz');
  const input = { equipment: [{ equipment_type: 'INJECTOR_RAIL', serial_number: 'A,B,C' }] };
  const line = writeCsvRow(columns.map((c) => c.value(input)));
  assert.ok(line.includes('"A,B,C"'));
});

test('serial migration is idempotent, preserves wider types, and never updates data or drops constraints', async () => {
  for (const type of ['varchar', 'text', 'mediumtext', 'longtext']) {
    let current = type;
    const queries = [];
    const conn = { execute: async (sql) => {
      queries.push(sql);
      if (sql.startsWith('SELECT')) return [[{ DATA_TYPE: current, IS_NULLABLE: 'YES' }]];
      current = 'text'; return [{}];
    } };
    await ensureEquipmentSerialText(conn);
    await ensureEquipmentSerialText(conn);
    assert.equal(queries.filter((q) => q.startsWith('ALTER')).length, type === 'varchar' ? 1 : 0);
    assert.ok(queries.every((q) => !/UPDATE |DELETE |DROP /i.test(q)));
  }
  const source = fs.readFileSync(require.resolve('../config/database'), 'utf8');
  assert.match(source, /UNIQUE KEY uq_warranty_equipment_type \(warranty_form_id, equipment_type\)/);
  assert.equal(EQUIPMENT_SERIAL_RULES.CYLINDER.max, null);
});

test('equipment edits preserve historical reward columns', async () => {
  const writes = [];
  await er.upsertMany({ execute: async (sql) => {
    if (sql.startsWith('SELECT')) return [[{ product_id: 1, serial_number: 'OLD' }]];
    writes.push(sql); return [{}];
  } }, 42, [{ equipment_type: 'INJECTOR_RAIL', product_id: 1, serial_number: 'A,B' }]);
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0], /reward_points|reward_transaction_id|point_transactions/);
});
