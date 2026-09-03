/**
 * Managed employee username parser (Beta-2, §31). Pure — no DB, no network.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseManagedEmployeeUsername } = require('../utils/managedUsername');
const { USERNAME_PREFIX_TO_BRANCH_TYPE, BRANCH_TYPES } = require('../config/branchTypes');

test('31.1 eg_ali_01_1 → EASYGAS + 01/1', () => {
  assert.deepEqual(parseManagedEmployeeUsername('eg_ali_01_1'), {
    managed: true, prefix: 'eg', branchType: 'EASYGAS', humanPart: 'ali',
    regionCode: '01', branchNumber: '1', branchCode: '01/1',
  });
});

test('31.2 st_sardor_10_1 → STAG_SERVICE + 10/1', () => {
  const p = parseManagedEmployeeUsername('st_sardor_10_1');
  assert.equal(p.branchType, 'STAG_SERVICE');
  assert.equal(p.branchCode, '10/1');
});

test('31.3 bs_ali_10_2 → OTHER_SERVICE + 10/2 (never THIRD_PARTY)', () => {
  const p = parseManagedEmployeeUsername('bs_ali_10_2');
  assert.equal(p.branchType, 'OTHER_SERVICE');
  assert.equal(p.branchCode, '10/2');
  assert.ok(BRANCH_TYPES.includes('OTHER_SERVICE') && !BRANCH_TYPES.includes('THIRD_PARTY'));
});

test('31.4 multi-token human part parses from BOTH ENDS: bs_service_master_12_14', () => {
  const p = parseManagedEmployeeUsername('bs_service_master_12_14');
  assert.equal(p.humanPart, 'service_master');
  assert.equal(p.branchCode, '12/14');
  assert.equal(p.branchType, 'OTHER_SERVICE');
});

test('31.5 unknown prefix rejected with the SPECIFIC prefix reason', () => {
  const p = parseManagedEmployeeUsername('xx_ali_01_1');
  assert.equal(p.managed, false);
  assert.equal(p.reason, 'INVALID_EMPLOYEE_USERNAME_PREFIX');
});

test('31.6 missing human part rejected (eg_01_1, eg__01_1)', () => {
  assert.equal(parseManagedEmployeeUsername('eg_01_1').managed, false);
  const p = parseManagedEmployeeUsername('eg__01_1');
  assert.equal(p.managed, false);
  assert.equal(p.reason, 'INVALID_EMPLOYEE_USERNAME_FORMAT');
});

test('31.7 region token must be EXACTLY 2 digits (eg_ali_1_1, eg_ali_001_1 rejected)', () => {
  assert.equal(parseManagedEmployeeUsername('eg_ali_1_1').managed, false);
  assert.equal(parseManagedEmployeeUsername('eg_ali_001_1').managed, false);
});

test('31.8 nonnumeric branch number rejected (eg_ali_01_x)', () => {
  assert.equal(parseManagedEmployeeUsername('eg_ali_01_x').managed, false);
});

test('31.9 malformed suffix / edges rejected', () => {
  for (const bad of ['eg_ali', 'eg_ali_01_', '_ali_01_1', 'eg', '', null, undefined, 'egali_01_1_']) {
    assert.equal(parseManagedEmployeeUsername(bad).managed, false, `should reject "${bad}"`);
  }
});

test('31.10 no hardcoded region mapping — output carries only the raw code, and the module has no region names', () => {
  const p = parseManagedEmployeeUsername('eg_ali_01_1');
  assert.deepEqual(Object.keys(p).sort(), ['branchCode', 'branchNumber', 'branchType', 'humanPart', 'managed', 'prefix', 'regionCode'].sort());
  const src = require('node:fs').readFileSync(require.resolve('../utils/managedUsername.js'), 'utf8');
  assert.ok(!/Toshkent|Sirdaryo|viloyat|shahri/i.test(src), 'parser must not map region codes to geography');
});

test('prefix map is exactly eg/st/bs and case-insensitive input keeps canonical lowercase prefix', () => {
  assert.deepEqual(Object.keys(USERNAME_PREFIX_TO_BRANCH_TYPE).sort(), ['bs', 'eg', 'st']);
  const p = parseManagedEmployeeUsername('EG_ali_01_1');
  assert.equal(p.managed, true);
  assert.equal(p.prefix, 'eg');
  assert.equal(p.branchType, 'EASYGAS');
});
