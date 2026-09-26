const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const cars = require('../repositories/carRepository');
const warranties = require('../repositories/warrantyRepository');
const equipment = require('../repositories/equipmentRepository');
const client = require('../services/easyGasWarrantyClient');
const sync = require('../services/easyGasWarrantySyncService');
const repair = require('../scripts/repairFailedEasyGasWarranty');

const originalFetch = global.fetch;
global.fetch = () => { throw new Error('Network forbidden in hotfix tests'); };
after(() => { global.fetch = originalFetch; });

const car = (over = {}) => ({ id: 9999, external_id: null, brand: 'Chevrolet', model: 'Cobalt', is_active: 1, ...over });
const form = (over = {}) => ({
  id: 42, submission_uuid: 'unchanged-uuid', warranty_book_number: 'LPG-26-000010',
  car_id: null, vehicle_name: 'Chevrolet Cobalt', status: 'SUCCESSFUL', fuel_type: 'LPG',
  owner_phone: '+998901234567', organization_phone: '+998 90 111 22 33',
  easygas_sync_result: 'FAILED', easygas_claim_url: null,
  easygas_sync_error: 'HTTP 422: FIELD_TOO_LONG', ...over,
});

const catalogConnection = (rows = []) => ({
  execute: async (sql, params) => {
    if (/WHERE id = \?/.test(sql)) return [rows.filter((row) => row.id === params[0])];
    assert.match(sql, /SELECT id, external_id, brand, model FROM cars WHERE is_active = TRUE/);
    return [rows.filter((row) => row.is_active === 1)];
  },
  release() {},
});

for (const [name, input, rows, expected] of [
  ['V1 free text', form(), [], [null, 'Chevrolet', 'Cobalt']],
  ['V2 multi-token model', form({ vehicle_name: '  Chevrolet\tCobalt   1.5 ' }), [], [null, 'Chevrolet', 'Cobalt 1.5']],
  ['V3 model-only catalog match', form({ vehicle_name: '  COBALT   1.5 ' }), [car({ external_id: '123', model: 'Cobalt 1.5' })], [123, 'Chevrolet', 'Cobalt 1.5']],
  ['V4 selected local-only car never leaks 9999', form({ car_id: 9999 }), [car()], [null, 'Chevrolet', 'Cobalt']],
  ['V5 selected external car', form({ car_id: 9999 }), [car({ external_id: '321' })], [321, 'Chevrolet', 'Cobalt']],
  ['V6 one token unresolved', form({ vehicle_name: 'Cobalt' }), [], [null, null, null]],
  ['V7 ambiguous model unresolved', form({ vehicle_name: 'Cobalt' }), [car(), car({ id: 8, brand: 'Other', external_id: 555 })], [null, null, null]],
  ['V8 inactive row excluded', form({ vehicle_name: 'Cobalt' }), [car({ is_active: 0, external_id: 123 })], [null, null, null]],
  ['missing selected car uses text', form({ car_id: 9999 }), [], [null, 'Chevrolet', 'Cobalt']],
  ['missing selected car uses catalog', form({ car_id: 333 }), [car({ external_id: 123 })], [123, 'Chevrolet', 'Cobalt']],
  ['full name takes priority over model-only', form(), [car({ external_id: 123 }), car({ id: 7, brand: 'Other', model: 'Chevrolet Cobalt', external_id: 456 })], [123, 'Chevrolet', 'Cobalt']],
  ['full-name normalization', form({ vehicle_name: '  chevrolet   COBALT ' }), [car({ brand: ' Chevrolet ', model: ' Cobalt ', external_id: '123' })], [123, 'Chevrolet', 'Cobalt']],
  ['duplicate full names do not choose ID', form(), [car({ external_id: 123 }), car({ id: 7, external_id: 456 })], [null, 'Chevrolet', 'Cobalt']],
  ['catalog without external ID uses catalog names', form({ vehicle_name: 'Cobalt' }), [car()], [null, 'Chevrolet', 'Cobalt']],
]) {
  test(name, async () => {
    const vehicle = await sync.resolveEasyGasVehicle(catalogConnection(rows), input);
    const payload = sync.buildPayload({ ...input, vehicle_brand: 'UNTRUSTED', vehicle_model: 'UNTRUSTED' }, [], vehicle);
    assert.deepEqual([payload.car_id, payload.vehicle_brand, payload.vehicle_model], expected);
    assert.notEqual(payload.car_id, 9999);
    assert.equal('source' in payload, false);
    assert.equal(payload.submission_uuid, input.submission_uuid);
  });
}

test('invalid external IDs never reach the wire as IDs', async () => {
  for (const external_id of ['', 'NaN', 'Infinity', '1.5', '-1', '0', '9007199254740992']) {
    const vehicle = await sync.resolveEasyGasVehicle(catalogConnection([car({ external_id })]), form({ car_id: 9999 }));
    assert.equal(vehicle.carId, null);
  }
});

async function runSync(t, input, result = { ok: true, data: { warranty: { claim_url: 'https://example.invalid/claim' } } }) {
  const posts = [];
  const writes = [];
  t.mock.method(warranties, 'findDetailById', async () => input);
  t.mock.method(equipment, 'findByWarrantyFormIds', async () => []);
  t.mock.method(client, 'submitWarranty', async (body) => { posts.push(JSON.parse(body)); return result; });
  // Use the real result repository to prove its SQL cannot update local status.
  const connection = catalogConnection();
  const read = connection.execute;
  connection.execute = async (sql, params) => {
    if (/^UPDATE/.test(sql.trim())) { writes.push({ sql, params }); return [{ affectedRows: 1 }]; }
    return read(sql, params);
  };
  await sync.syncWarrantyForm({ getConnection: async () => connection }, input.id);
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0].sql, /\bstatus\s*=/);
  assert.equal(input.status, 'SUCCESSFUL');
  return { posts, write: writes[0] };
}

for (const number of ['LPG-2026-000010', null, 123, '']) {
  test(`P1 invalid number ${JSON.stringify(number)} records FAILED without HTTP`, async (t) => {
    const { posts, write } = await runSync(t, form({ warranty_book_number: number }));
    assert.equal(posts.length, 0);
    assert.deepEqual(write.params.slice(0, 2), ['FAILED', null]);
    assert.match(write.params[2], /^invalid_warranty_book_number:/);
  });
}

test('P2 unresolved identity records FAILED without HTTP', async (t) => {
  const { posts, write } = await runSync(t, form({ vehicle_name: 'Cobalt' }));
  assert.equal(posts.length, 0);
  assert.deepEqual(write.params.slice(0, 2), ['FAILED', null]);
  assert.match(write.params[2], /^vehicle_identity_unresolved:/);
});

test('P3 valid resolved payload calls existing client exactly once', async (t) => {
  const { posts, write } = await runSync(t, form());
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0].car_id, posts[0].vehicle_brand, posts[0].vehicle_model], [null, 'Chevrolet', 'Cobalt']);
  assert.equal(posts[0].organization_phone, '+998901112233');
  assert.equal(write.params[0], 'SUCCESS');
});

for (const result of [
  { ok: false, status: 422, data: { errors: [{ code: 'FIELD_REQUIRED' }] } },
  { ok: false, networkError: true, errorMessage: 'timeout' },
]) {
  test(`P4 remote failure ${result.status || 'network'} preserves local SUCCESSFUL`, async (t) => {
    const { posts, write } = await runSync(t, form(), result);
    assert.equal(posts.length, 1);
    assert.equal(write.params[0], 'FAILED');
    assert.equal(write.params[1], null);
  });
}

const repairFixture = (over = {}, { collision = false, affectedRows = 1, busy = false } = {}) => {
  const row = form({ warranty_book_number: 'LPG-2026-000010', ...over });
  const calls = [];
  const connection = {
    beginTransaction: async () => { calls.push('BEGIN'); },
    commit: async () => { calls.push('COMMIT'); },
    rollback: async () => { calls.push('ROLLBACK'); },
    release: () => { calls.push('RELEASE'); },
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('GET_LOCK')) return [[{ acquired: busy ? 0 : 1 }]];
      if (sql.includes('RELEASE_LOCK')) return [[{}]];
      if (sql.includes('AND id <>')) return [collision ? [{ id: 9 }] : []];
      if (sql.trim().startsWith('UPDATE')) {
        assert.match(sql, /^UPDATE warranty_forms SET warranty_book_number = \?/);
        assert.match(sql, /status = 'SUCCESSFUL'/);
        assert.match(sql, /easygas_sync_result = 'FAILED'/);
        assert.match(sql, /easygas_claim_url IS NULL/);
        assert.match(sql, /easygas_sync_error = \?/);
        assert.deepEqual(params.slice(1), [42, row.warranty_book_number, row.easygas_sync_error]);
        if (affectedRows) row.warranty_book_number = params[0];
        return [{ affectedRows }];
      }
      if (sql.includes('AS claim_url_present')) return [[{
        easygas_sync_result: row.easygas_sync_result, claim_url_present: row.easygas_claim_url != null,
        easygas_sync_error: row.easygas_sync_error,
      }]];
      assert.match(sql, /FROM warranty_forms WHERE id = \?/);
      return [[{ ...row }]];
    },
  };
  const pool = { getConnection: async () => connection };
  return { row, calls, pool, connection };
};
const noSync = () => { assert.fail('Unexpected EasyGas sync'); };
const quiet = () => {};

test('CLI requires exactly one ID and one mode, rejects unknown/duplicate flags', () => {
  for (const args of [[], ['--id', '42'], ['--apply'], ['--id', '0', '--apply'],
    ['--id', '42', '--apply', '--retry'], ['--id', '42', '--dry-run', '--dry-run'],
    ['--id', '42', '--id', '43', '--apply'], ['--id', '42', '--all'], ['--id', '1.5', '--apply']]) {
    assert.throws(() => repair.parseArgs(args), /Usage:/);
  }
  assert.deepEqual(repair.parseArgs(['--id', '42', '--dry-run']), { id: 42, mode: 'dry-run' });
});

test('R1/R4 dry-run is read-only and proposes exact suffix-preserving repair without PII', async () => {
  const f = repairFixture();
  const result = await repair.run({ id: 42, mode: 'dry-run' }, { pool: f.pool, syncWarrantyForm: noSync, report: quiet });
  assert.equal(result.proposed_warranty_book_number, 'LPG-26-000010');
  assert.equal(result.eligible, true);
  assert.ok(f.calls.filter((x) => x.sql).every((x) => /^SELECT/.test(x.sql.trim())));
  assert.ok(!f.calls.includes('BEGIN'));
  assert.equal(f.row.warranty_book_number, 'LPG-2026-000010');
  assert.doesNotMatch(JSON.stringify(result), /unchanged-uuid|owner_phone|vehicle_name/);
});

for (const [name, over] of [
  ['sync success', { easygas_sync_result: 'SUCCESS' }],
  ['claim present', { easygas_claim_url: 'https://example.invalid/claim' }],
  ['non-null empty claim', { easygas_claim_url: '' }],
  ['wrong local status', { status: 'PENDING' }],
  ['wrong error', { easygas_sync_error: 'Network error' }],
  ['historical W', { warranty_book_number: 'W-2026-000010' }],
  ['already repaired', { warranty_book_number: 'LPG-26-000010' }],
]) {
  test(`R2/R3 repair refuses ${name}`, async () => {
    const f = repairFixture(over);
    await assert.rejects(repair.run({ id: 42, mode: 'apply' }, { pool: f.pool, syncWarrantyForm: noSync, report: quiet }), /repair_refused/);
    assert.equal(f.calls.filter((x) => x.sql?.startsWith('UPDATE')).length, 0);
    assert.ok(f.calls.includes('ROLLBACK'));
  });
}

test('R5/R6/R8 apply changes only number, preserves UUID/history, no sequence or HTTP', async () => {
  const f = repairFixture();
  const before = { ...f.row };
  const result = await repair.run({ id: 42, mode: 'apply' }, { pool: f.pool, syncWarrantyForm: noSync, report: quiet });
  assert.deepEqual(f.row, { ...before, warranty_book_number: 'LPG-26-000010' });
  assert.equal(result.warranty_book_number, 'LPG-26-000010');
  assert.equal(f.calls.filter((x) => x.sql?.startsWith('UPDATE')).length, 1);
  assert.doesNotMatch(JSON.stringify(f.calls), /warranty_number_sequences/);
  assert.ok(f.calls.includes('COMMIT'));
  assert.ok(f.calls.some((x) => x.sql?.includes('FOR UPDATE')));
});

test('R7 collision refuses apply and is visible in dry-run', async () => {
  for (const mode of ['dry-run', 'apply']) {
    const f = repairFixture({}, { collision: true });
    const operation = repair.run({ id: 42, mode }, { pool: f.pool, syncWarrantyForm: noSync, report: quiet });
    if (mode === 'apply') await assert.rejects(operation, /number_collision/);
    else assert.deepEqual((await operation).reasons, ['number_collision']);
    assert.equal(f.calls.filter((x) => x.sql?.startsWith('UPDATE')).length, 0);
  }
});

test('repair parser supports CNG and other 20xx years', () => {
  assert.equal(repair.inspect(form({ warranty_book_number: 'CNG-2031-000011' })).proposed_warranty_book_number, 'CNG-31-000011');
});

test('apply detects state change and rolls back', async () => {
  const f = repairFixture({}, { affectedRows: 0 });
  await assert.rejects(repair.run({ id: 42, mode: 'apply' }, { pool: f.pool, syncWarrantyForm: noSync, report: quiet }), /repair_state_changed/);
  assert.ok(f.calls.includes('ROLLBACK'));
});

test('concurrent operator invocation refuses before reading or submitting', async () => {
  const f = repairFixture({}, { busy: true });
  await assert.rejects(repair.run({ id: 42, mode: 'retry' }, { pool: f.pool, syncWarrantyForm: noSync, report: quiet }), /repair_already_running/);
  assert.equal(f.calls.filter((x) => x.sql).length, 1);
});

test('R9 retry uses real sync path once, same form and UUID, and refuses subsequent success', async (t) => {
  const f = repairFixture({ warranty_book_number: 'LPG-26-000010' });
  const posts = [];
  t.mock.method(warranties, 'findDetailById', async (_conn, id) => { assert.equal(id, 42); return { ...f.row }; });
  t.mock.method(equipment, 'findByWarrantyFormIds', async () => []);
  t.mock.method(cars, 'findActiveExactMatch', async () => null);
  t.mock.method(client, 'submitWarranty', async (body) => {
    posts.push(JSON.parse(body));
    assert.ok(!f.calls.includes('BEGIN'), 'no transaction during HTTP');
    return { ok: true, data: { warranty: { claim_url: 'https://example.invalid/claim' } } };
  });
  t.mock.method(warranties, 'updateEasyGasSyncResult', async (_conn, id, value) => {
    assert.equal(id, 42);
    Object.assign(f.row, { easygas_sync_result: value.result, easygas_claim_url: value.claimUrl, easygas_sync_error: value.error });
  });
  const syncSpy = t.mock.fn(sync.syncWarrantyForm);
  const result = await repair.run({ id: 42, mode: 'retry' }, { pool: f.pool, syncWarrantyForm: syncSpy, report: quiet });
  assert.equal(syncSpy.mock.callCount(), 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].submission_uuid, 'unchanged-uuid');
  assert.equal(posts[0].external_ref, '42');
  assert.equal(f.row.submission_uuid, 'unchanged-uuid');
  assert.equal(f.row.status, 'SUCCESSFUL');
  assert.equal(result.easygas_sync_result, 'SUCCESS');
  await assert.rejects(repair.run({ id: 42, mode: 'retry' }, { pool: f.pool, syncWarrantyForm: noSync, report: quiet }), /retry_refused/);
});

test('retry refuses long number before sync', async () => {
  const f = repairFixture();
  await assert.rejects(repair.run({ id: 42, mode: 'retry' }, { pool: f.pool, syncWarrantyForm: noSync, report: quiet }), /short_number_required/);
});
