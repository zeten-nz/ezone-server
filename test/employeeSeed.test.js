/**
 * Production employee seed (workbook → managed employees). node:test, no
 * live DB, SYNTHETIC fixtures only — no real PII from the production
 * workbook appears here. The apply path runs the REAL
 * services/managedEmployeeService.js against the same transactional
 * in-memory connection fake pattern the Beta-2 suites use, so branch
 * locking/classification/rollback semantics are exercised as wired.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');

const { transliterateToSlug, extractGivenNameSlug } = require('../utils/uzbekTranslit');
const { extractRawRows, parseSeedRows, parseServicePrefix, normalizeEmployeePhone, maskPhone } = require('../utils/seedWorkbookParser');
const { planSeed, applySeed, buildSeedUsername, generateTemporaryPassword } = require('../services/employeeSeedService');
const { openCredentialsFile } = require('../scripts/seedProductionEmployees');

// ── transliteration (§8) ────────────────────────────────────────────────────
test('transliteration: required identifier-style mappings', () => {
  assert.equal(transliterateToSlug('Жахонгир'), 'jaxongir');   // Ж→j, Х→x
  assert.equal(transliterateToSlug('Шерматов'), 'shermatov');  // Ш→sh
  assert.equal(transliterateToSlug('Чоршанбиев'), 'chorshanbiev'); // Ч→ch
  assert.equal(transliterateToSlug('Ёркин'), 'yorkin');        // Ё→yo
  assert.equal(transliterateToSlug('Юлдашев'), 'yuldashev');   // Ю→yu
  assert.equal(transliterateToSlug('Яхшимов'), 'yaxshimov');   // Я→ya
  assert.equal(transliterateToSlug('Қодиров'), 'qodirov');     // Қ→q
  assert.equal(transliterateToSlug('Ғафур'), 'gafur');         // Ғ→g
  assert.equal(transliterateToSlug('Ҳабибулло'), 'habibullo'); // Ҳ→h
  assert.equal(transliterateToSlug('Ўткир'), 'otkir');         // Ў→o
});

test('transliteration: Latin passthrough, apostrophes stripped, lowercase output', () => {
  assert.equal(transliterateToSlug('NIZOMIDDIN'), 'nizomiddin');
  assert.equal(transliterateToSlug("O'tkir"), 'otkir');
  assert.equal(transliterateToSlug('Sunatillo'), 'sunatillo');
  assert.equal(transliterateToSlug('Хайитбоевич'), 'xayitboevich');
});

// ── given-name extraction (§7) ──────────────────────────────────────────────
test('name extraction: SURNAME GIVEN PATRONYMIC → token #2', () => {
  assert.equal(extractGivenNameSlug('Юлдашев Жахонгир Хайитбоевич'), 'jaxongir');
  assert.equal(extractGivenNameSlug('Атаджанов Ойбек Анварович'), 'oybek');
});

test('name extraction: single usable token used as-is', () => {
  assert.equal(extractGivenNameSlug('Шерматов'), 'shermatov');
});

test('name extraction: initial-only token #2 falls back to token #1', () => {
  assert.equal(extractGivenNameSlug('Юлдашев Ж.'), 'yuldashev');
});

test('name extraction: no usable token → null (never guessed)', () => {
  assert.equal(extractGivenNameSlug('. .'), null);
  assert.equal(extractGivenNameSlug(''), null);
});

// ── workbook parsing (§18 isolation; §1 G handling; header layout) ──────────
const buildSyntheticWorkbook = async () => {
  const Excel = require('exceljs');
  const wb = new Excel.Workbook();
  const ws = wb.addWorksheet('16,06,2026');
  ws.getCell('B1').value = 'Synthetic banner title';
  ws.getCell('B2').value = 'РУЙХАТИ';
  ws.getCell('B4').value = 'Тошкент шахри буйича';
  const header = ['Т/р', 'Ташкилот номи', 'Ташкилот рахбари', 'Ташкилот манзили', 'Рахбар телефон раками', 'Ходим телефон раками'];
  header.forEach((h, i) => { ws.getCell(6, i + 1).value = h; });
  const data = [
    ['01/1', 'Test Org MChJ', 'Тестов Жахонгир Тестович', 'Addr 1', '(11) 111 11 11', '(98) 302 28 44', 'eg'],
    ['20/2', 'Org Two', 'Боротов Рустам', 'Addr 2', '(22) 222 22 22', '(93) 555 66 08', ' EG '],
    ['Тошкент вилояти буйича', '', '', '', '', '', ''], // region heading — must be skipped
    ['20/3', 'Org Three', 'Бобоев Мурод', 'Addr 3', '(33) 333 33 33', '(93) 555 66 08', 'Bs'],
    ['10/6', '', '', '', '', '', ''],                    // ghost row — code only
    ['30/1', 'Org Four', 'Каримов Карим', 'Addr 4', '', '(90) 111 22 33', 'xx'], // invalid G
    ['40/1', 'Org Five', 'Ахмедов Али', 'Addr 5', '', '(91) 222 33 44', ''],     // blank G
  ];
  data.forEach((cells, r) => cells.forEach((v, c) => { ws.getCell(7 + r, c + 1).value = v; }));
  return ws;
};

test('workbook: header row detected at 6, headings/banners skipped, NN/N rows extracted', async () => {
  const ws = await buildSyntheticWorkbook();
  const { headerRowNumber, branchRows, skippedRows } = parseSeedRows(extractRawRows(ws));
  assert.equal(headerRowNumber, 6);
  assert.deepEqual(branchRows.map((r) => r.branchCode), ['01/1', '20/2', '20/3', '10/6', '30/1', '40/1']);
  assert.ok(skippedRows.some((s) => s.label.includes('Тошкент вилояти')));
  assert.ok(skippedRows.some((s) => s.label.includes('Synthetic banner')));
});

test('workbook: ghost row flagged; employee phone comes from column F, never E', async () => {
  const ws = await buildSyntheticWorkbook();
  const { branchRows } = parseSeedRows(extractRawRows(ws));
  assert.equal(branchRows.find((r) => r.branchCode === '10/6').isGhost, true);
  assert.equal(branchRows.find((r) => r.branchCode === '01/1').isGhost, false);
  const row = branchRows.find((r) => r.branchCode === '01/1');
  assert.equal(normalizeEmployeePhone(row.employeePhoneRaw).phone, '+998983022844'); // F, not E's 111…
});

test('G prefix: case-insensitive + trimmed → canonical; invalid/blank rejected', () => {
  assert.deepEqual(parseServicePrefix('eg'), { prefix: 'eg' });
  assert.deepEqual(parseServicePrefix(' EG '), { prefix: 'eg' });
  assert.deepEqual(parseServicePrefix('St'), { prefix: 'st' });
  assert.deepEqual(parseServicePrefix('bS'), { prefix: 'bs' });
  assert.deepEqual(parseServicePrefix('xx'), { error: 'INVALID_SERVICE_PREFIX' });
  assert.deepEqual(parseServicePrefix('easygas'), { error: 'INVALID_SERVICE_PREFIX' });
  assert.deepEqual(parseServicePrefix(''), { error: 'MISSING_SERVICE_PREFIX' });
  assert.deepEqual(parseServicePrefix('   '), { error: 'MISSING_SERVICE_PREFIX' });
});

test('phone: confident 9-digit reductions only', () => {
  assert.deepEqual(normalizeEmployeePhone('(98) 302 28 44'), { phone: '+998983022844' });
  assert.deepEqual(normalizeEmployeePhone('+998 90 123 45 67'), { phone: '+998901234567' });
  assert.deepEqual(normalizeEmployeePhone('998901234567'), { phone: '+998901234567' });
  assert.deepEqual(normalizeEmployeePhone('90123'), { error: 'INVALID_PHONE' });
  assert.deepEqual(normalizeEmployeePhone('8801234567'), { error: 'INVALID_PHONE' }); // 10 digits, no 998
  assert.deepEqual(normalizeEmployeePhone(''), { error: 'MISSING_PHONE' });
  assert.ok(!maskPhone('+998983022844').includes('3022')); // masked in output
});

// ── username generation (§7) ────────────────────────────────────────────────
test('username: <prefix>_<given-slug>_<region>_<branchNumber>, round-trips the branch code', () => {
  assert.deepEqual(buildSeedUsername({ prefix: 'eg', fullName: 'Юлдашев Жахонгир Хайитбоевич', branchCode: '01/1' }), { username: 'eg_jaxongir_01_1' });
  assert.deepEqual(buildSeedUsername({ prefix: 'bs', fullName: 'ABDUQODIROV NIZOMIDDIN', branchCode: '20/20' }), { username: 'bs_nizomiddin_20_20' });
  assert.deepEqual(buildSeedUsername({ prefix: 'st', fullName: '', branchCode: '01/1' }), { error: 'MISSING_NAME' });
  assert.deepEqual(buildSeedUsername({ prefix: 'st', fullName: '. .', branchCode: '01/1' }), { error: 'INVALID_NAME' });
});

// ── transactional in-memory DB fake (same pattern as the Beta-2 suites) ────
const makeDb = () => ({
  branches: [
    { id: 1, code: '01/1', name: 'Test Org MChJ', branch_type: null },
    { id: 2, code: '20/2', name: 'Org Two', branch_type: null },
    { id: 3, code: '20/3', name: 'Org Three', branch_type: null },
    { id: 4, code: '20/8', name: 'Org Eight', branch_type: null },
    { id: 5, code: '20/20', name: 'Org Twenty', branch_type: null },
    { id: 6, code: '77/7', name: 'Stag Branch', branch_type: 'STAG_SERVICE' },
    { id: 7, code: '30/1', name: 'Org Four', branch_type: null },
  ],
  users: [],
  nextUserId: 100,
  writes: 0,
  transactions: 0,
  failInsertFor: null,
});

const makeConnection = (db) => {
  let snapshot = null;
  return {
    async beginTransaction() { db.transactions += 1; snapshot = JSON.parse(JSON.stringify({ branches: db.branches, users: db.users })); },
    async commit() { snapshot = null; },
    async rollback() { if (snapshot) { db.branches = snapshot.branches; db.users = snapshot.users; snapshot = null; } },
    release() {},
    async execute(sql, params = []) {
      if (/SELECT id, code, name, branch_type FROM branches WHERE code = \?/.test(sql)) {
        return [db.branches.filter((b) => b.code === params[0]).map((b) => ({ ...b }))];
      }
      if (/SELECT id, username, role, branch_id, phone, full_name FROM users WHERE username = \?/.test(sql)) {
        return [db.users.filter((u) => u.username === params[0]).map((u) => ({ ...u }))];
      }
      if (/SELECT id FROM users WHERE username = \?/.test(sql)) {
        return [db.users.filter((u) => u.username === params[0]).map((u) => ({ id: u.id }))];
      }
      if (/SELECT id, code, branch_type FROM branches WHERE id = \? FOR UPDATE/.test(sql)) {
        return [db.branches.filter((b) => b.id === Number(params[0])).map((b) => ({ id: b.id, code: b.code, branch_type: b.branch_type }))];
      }
      if (/UPDATE branches SET branch_type = \? WHERE id = \? AND branch_type IS NULL/.test(sql)) {
        db.writes += 1;
        const b = db.branches.find((x) => x.id === Number(params[1]));
        if (b && b.branch_type === null) { b.branch_type = params[0]; return [{ affectedRows: 1 }]; }
        return [{ affectedRows: 0 }];
      }
      if (/SELECT branch_type FROM branches WHERE id = \?/.test(sql)) {
        return [db.branches.filter((b) => b.id === Number(params[0])).map((b) => ({ branch_type: b.branch_type }))];
      }
      if (/INSERT INTO users/.test(sql)) {
        db.writes += 1;
        if (db.failInsertFor && params[1] === db.failInsertFor) throw new Error('induced insert failure');
        const id = db.nextUserId++;
        db.users.push({ id, full_name: params[0], username: params[1], password: params[2], phone: params[3], branch_id: params[4], role: params[5], is_active: 1 });
        return [{ insertId: id, affectedRows: 1 }];
      }
      throw new Error(`fake connection: unhandled SQL: ${sql}`);
    },
  };
};

const mkRow = (over = {}) => ({
  rowNumber: 7, branchCode: '01/1', orgName: 'Test Org MChJ',
  fullName: 'Тестов Жахонгир Тестович', address: 'Addr',
  leaderPhoneRaw: '(11) 111 11 11', employeePhoneRaw: '(98) 302 28 44',
  servicePrefixRaw: 'eg', isGhost: false, ...over,
});

const planWith = (db, rows) => planSeed({ rows, getConnection: async () => makeConnection(db) });

// ── planner statuses ────────────────────────────────────────────────────────
test('plan: clean row → READY with generated username and normalized phone', async () => {
  const db = makeDb();
  const plan = await planWith(db, [mkRow()]);
  assert.equal(plan.entries[0].status, 'READY');
  assert.equal(plan.entries[0].username, 'eg_jaxongir_01_1');
  assert.equal(plan.entries[0].phone, '+998983022844');
  assert.equal(plan.blockers.length, 0);
});

test('plan: ghost row → INCOMPLETE_SOURCE_DATA, checked before the G prefix, not a blocker', async () => {
  const db = makeDb();
  const plan = await planWith(db, [mkRow({ branchCode: '10/6', orgName: '', fullName: '', leaderPhoneRaw: '', employeePhoneRaw: '', servicePrefixRaw: '', isGhost: true })]);
  assert.equal(plan.entries[0].status, 'INCOMPLETE_SOURCE_DATA');
  assert.equal(plan.blockers.length, 0);
  assert.equal(plan.usedDb, false); // never even needed the DB
});

test('plan: blank/invalid G → MISSING/INVALID_SERVICE_PREFIX blockers, no DB access, no inference from org name', async () => {
  const db = makeDb();
  const plan = await planWith(db, [
    mkRow({ servicePrefixRaw: '' }),
    mkRow({ branchCode: '20/2', servicePrefixRaw: 'zz' }),
  ]);
  assert.equal(plan.entries[0].status, 'MISSING_SERVICE_PREFIX');
  assert.equal(plan.entries[1].status, 'INVALID_SERVICE_PREFIX');
  assert.equal(plan.blockers.length, 2);
  assert.equal(plan.usedDb, false);
  assert.equal(db.writes, 0);
});

test('plan: name/phone problems → MISSING_NAME / INVALID_NAME / MISSING_PHONE / INVALID_PHONE', async () => {
  const db = makeDb();
  const plan = await planWith(db, [
    mkRow({ fullName: '' }),
    mkRow({ fullName: '. .' }),
    mkRow({ employeePhoneRaw: '' }),
    mkRow({ employeePhoneRaw: '12345' }),
  ]);
  assert.deepEqual(plan.entries.map((e) => e.status), ['MISSING_NAME', 'INVALID_NAME', 'MISSING_PHONE', 'INVALID_PHONE']);
  assert.equal(plan.blockers.length, 4);
});

test('plan: unknown branch code → MISSING_LOCAL_BRANCH (branches never created from Excel)', async () => {
  const db = makeDb();
  const plan = await planWith(db, [mkRow({ branchCode: '99/9' })]);
  assert.equal(plan.entries[0].status, 'MISSING_LOCAL_BRANCH');
  assert.equal(db.writes, 0);
});

test('plan: classified branch conflicting with G prefix → BRANCH_TYPE_CONFLICT', async () => {
  const db = makeDb();
  const plan = await planWith(db, [mkRow({ branchCode: '77/7', servicePrefixRaw: 'eg' })]);
  assert.equal(plan.entries[0].status, 'BRANCH_TYPE_CONFLICT');
});

test('plan: matching classified branch is fine (idempotent classification)', async () => {
  const db = makeDb();
  const plan = await planWith(db, [mkRow({ branchCode: '77/7', servicePrefixRaw: 'st' })]);
  assert.equal(plan.entries[0].status, 'READY');
});

test('plan: org-name difference → WARNING only, local branch stays authoritative', async () => {
  const db = makeDb();
  const plan = await planWith(db, [mkRow({ orgName: 'Completely Different Name' })]);
  assert.equal(plan.entries[0].status, 'READY');
  assert.ok(plan.entries[0].warnings.some((w) => w.code === 'ORGANIZATION_NAME_DIFFERENCE'));
  assert.equal(db.branches[0].name, 'Test Org MChJ'); // untouched
});

// ── duplicate phones (§3, §4, §5) ───────────────────────────────────────────
test('plan: 20/2 + 20/3 — two DIFFERENT people, same phone → both READY, DUPLICATE_PHONE warnings, separate usernames', async () => {
  const db = makeDb();
  const plan = await planWith(db, [
    mkRow({ rowNumber: 40, branchCode: '20/2', fullName: 'Боротов Рустам', employeePhoneRaw: '(93) 555 66 08' }),
    mkRow({ rowNumber: 41, branchCode: '20/3', fullName: 'Бобоев Мурод', employeePhoneRaw: '(93) 555 66 08' }),
  ]);
  assert.deepEqual(plan.entries.map((e) => e.status), ['READY', 'READY']);
  assert.deepEqual(plan.entries.map((e) => e.username), ['eg_rustam_20_2', 'eg_murod_20_3']);
  assert.ok(plan.entries.every((e) => e.warnings.some((w) => w.code === 'DUPLICATE_PHONE')));
  assert.equal(plan.blockers.length, 0); // warning, never an error
});

test('plan: 20/8 + 20/20 — same person, two branches → TWO branch-specific accounts, never merged', async () => {
  const db = makeDb();
  const plan = await planWith(db, [
    mkRow({ rowNumber: 46, branchCode: '20/8', fullName: 'Абдукадиров Низомиддин Су', employeePhoneRaw: '(94) 777 88 09' }),
    mkRow({ rowNumber: 58, branchCode: '20/20', fullName: 'ABDUQODIROV NIZOMIDDIN', employeePhoneRaw: '(94) 777 88 09' }),
  ]);
  assert.deepEqual(plan.entries.map((e) => e.status), ['READY', 'READY']);
  assert.deepEqual(plan.entries.map((e) => e.username), ['eg_nizomiddin_20_8', 'eg_nizomiddin_20_20']);
  assert.ok(plan.entries.every((e) => e.warnings.some((w) => w.code === 'DUPLICATE_PHONE')));
});

// ── idempotency & collisions (§17) ──────────────────────────────────────────
test('plan: existing EMPLOYEE on the same branch → ALREADY_EXISTS, not a blocker', async () => {
  const db = makeDb();
  db.users.push({ id: 50, username: 'eg_jaxongir_01_1', role: 'EMPLOYEE', branch_id: 1, phone: '+998983022844', full_name: 'Тестов Жахонгир Тестович', password: 'hash', is_active: 1 });
  const plan = await planWith(db, [mkRow()]);
  assert.equal(plan.entries[0].status, 'ALREADY_EXISTS');
  assert.equal(plan.blockers.length, 0);
});

test('plan: existing username on a DIFFERENT branch/identity → USERNAME_COLLISION blocker, never auto-suffixed', async () => {
  const db = makeDb();
  db.users.push({ id: 51, username: 'eg_jaxongir_01_1', role: 'EMPLOYEE', branch_id: 7, phone: null, full_name: 'Other', password: 'hash', is_active: 1 });
  const plan = await planWith(db, [mkRow()]);
  assert.equal(plan.entries[0].status, 'USERNAME_COLLISION');
  assert.equal(plan.blockers.length, 1);
  assert.ok(!plan.entries.some((e) => /\d+_[a-z]+\d+$/.test(String(e.username).replace('eg_jaxongir_01_1', '')))); // no suffixing anywhere
});

// ── dry-run purity ──────────────────────────────────────────────────────────
test('dry-run semantics: planning performs ZERO writes and ZERO transactions', async () => {
  const db = makeDb();
  await planWith(db, [mkRow(), mkRow({ branchCode: '20/2', fullName: 'Боротов Рустам' }), mkRow({ branchCode: '10/6', isGhost: true, servicePrefixRaw: '' })]);
  assert.equal(db.writes, 0);
  assert.equal(db.transactions, 0);
  assert.equal(db.users.length, 0);
});

// ── apply (§10, §12, §13, §16) ──────────────────────────────────────────────
const collectWriter = () => { const lines = []; return { lines, writeLine: (l) => lines.push(l) }; };

test('apply: creates READY rows through the REAL managedEmployeeService — branch classified NULL→type atomically with the insert', async () => {
  const db = makeDb();
  const plan = await planWith(db, [mkRow()]);
  const writer = collectWriter();
  const logs = [];
  const result = await applySeed({ plan, getConnection: async () => makeConnection(db), credentialsWriter: writer, log: (l) => logs.push(l) });
  assert.equal(result.created.length, 1);
  const user = db.users.find((u) => u.username === 'eg_jaxongir_01_1');
  assert.ok(user);
  assert.equal(user.role, 'EMPLOYEE');
  assert.equal(user.branch_id, 1);
  assert.equal(user.full_name, 'Тестов Жахонгир Тестович'); // original spelling, never transliterated
  assert.equal(db.branches.find((b) => b.code === '01/1').branch_type, 'EASYGAS');
  // credentials: exactly one line, for the new user only
  assert.equal(writer.lines.length, 1);
  assert.equal(writer.lines[0].username, 'eg_jaxongir_01_1');
  assert.equal(writer.lines[0].branch_code, '01/1');
  assert.equal(writer.lines[0].phone, '+998983022844');
  // password hygiene: >=14 chars, bcrypt-hashed in DB, plaintext nowhere in DB or logs
  const pw = writer.lines[0].temporary_password;
  assert.ok(pw.length >= 14);
  assert.ok(user.password.startsWith('$2'));
  assert.notEqual(user.password, pw);
  assert.ok(await bcrypt.compare(pw, user.password));
  assert.ok(logs.every((l) => !l.includes(pw)));
});

test('apply: per-row failure rolls back user AND classification, other rows still apply', async () => {
  const db = makeDb();
  db.failInsertFor = 'eg_rustam_20_2';
  const plan = await planWith(db, [
    mkRow({ branchCode: '20/2', fullName: 'Боротов Рустам' }),
    mkRow({ branchCode: '20/3', fullName: 'Бобоев Мурод' }),
  ]);
  const writer = collectWriter();
  const result = await applySeed({ plan, getConnection: async () => makeConnection(db), credentialsWriter: writer });
  assert.equal(result.failed.length, 1);
  assert.equal(result.created.length, 1);
  assert.equal(db.branches.find((b) => b.code === '20/2').branch_type, null); // classification rolled back with the row
  assert.equal(db.branches.find((b) => b.code === '20/3').branch_type, 'EASYGAS');
  assert.ok(!db.users.some((u) => u.username === 'eg_rustam_20_2'));
  assert.equal(writer.lines.length, 1); // no credentials for the failed row
});

test('apply: concurrent conflicting classification between plan and apply → enforceForCreate BRANCH_TYPE_CONFLICT, row fails, rolled back', async () => {
  const db = makeDb();
  const plan = await planWith(db, [mkRow()]);
  db.branches.find((b) => b.code === '01/1').branch_type = 'STAG_SERVICE'; // sneaks in after planning
  const writer = collectWriter();
  const result = await applySeed({ plan, getConnection: async () => makeConnection(db), credentialsWriter: writer });
  assert.equal(result.created.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /BRANCH_TYPE_CONFLICT/);
  assert.equal(db.users.length, 0);
  assert.equal(writer.lines.length, 0);
});

test('apply: idempotent rerun → ALREADY_EXISTS, no insert, no password reset, no new credentials', async () => {
  const db = makeDb();
  const writer1 = collectWriter();
  const plan1 = await planWith(db, [mkRow()]);
  await applySeed({ plan: plan1, getConnection: async () => makeConnection(db), credentialsWriter: writer1 });
  const storedHash = db.users[0].password;

  const writer2 = collectWriter();
  const plan2 = await planWith(db, [mkRow()]);
  assert.equal(plan2.entries[0].status, 'ALREADY_EXISTS');
  const result2 = await applySeed({ plan: plan2, getConnection: async () => makeConnection(db), credentialsWriter: writer2 });
  assert.equal(result2.created.length, 0);
  assert.equal(db.users.length, 1);
  assert.equal(db.users[0].password, storedHash); // untouched
  assert.equal(writer2.lines.length, 0);
});

test('apply: race between plan and apply (username appears) → skipped as ALREADY_EXISTS at apply, no credentials', async () => {
  const db = makeDb();
  const plan = await planWith(db, [mkRow()]);
  db.users.push({ id: 60, username: 'eg_jaxongir_01_1', role: 'EMPLOYEE', branch_id: 1, phone: null, full_name: 'X', password: 'h', is_active: 1 });
  const writer = collectWriter();
  const result = await applySeed({ plan, getConnection: async () => makeConnection(db), credentialsWriter: writer });
  assert.equal(result.created.length, 0);
  assert.equal(db.users.length, 1);
  assert.equal(writer.lines.length, 0);
});

// ── password generator ──────────────────────────────────────────────────────
test('passwords: crypto-generated, >=14 chars, unique per call', () => {
  const a = generateTemporaryPassword();
  const b = generateTemporaryPassword();
  assert.ok(a.length >= 14 && b.length >= 14);
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9]+$/);
});

// ── credentials file handling (§13) ─────────────────────────────────────────
test('credentials file: exclusive create, header written; existing file never silently overwritten; must be outside the repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezone-seed-test-'));
  const file = path.join(dir, 'creds.csv');
  const writer = openCredentialsFile(file);
  writer.writeLine({ branch_code: '01/1', full_name: '=Evil Name', username: 'eg_a_01_1', temporary_password: 'p'.repeat(16), phone: '+998901234567' });
  writer.close();
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('branch_code,full_name,username,temporary_password,phone'));
  assert.ok(content.includes("'=Evil Name")); // formula-injection escape reused from csvStream
  assert.throws(() => openCredentialsFile(file), /EEXIST/); // no silent overwrite
  const repoRoot = path.resolve(__dirname, '..');
  assert.throws(() => openCredentialsFile(path.join(repoRoot, 'creds.csv')), /OUTSIDE the repository/);
  fs.rmSync(dir, { recursive: true, force: true });
});
