/**
 * Username-driven branch classification (Beta-2, §32-§34). node:test — no
 * live DB: the REAL routes/userRoutes.js + middleware/auth.js +
 * controllers/userController.js + services/managedEmployeeService.js run
 * against a tiny transactional in-memory SQL fake (snapshot on
 * beginTransaction, restore on rollback), so atomicity, the FOR UPDATE
 * read, the conditional classification UPDATE, and every error contract are
 * exercised exactly as production wires them.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'beta2-test-secret';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../config/database');
const managedEmployeeService = require('../services/managedEmployeeService');

// ── in-memory data ──
const db = { branches: [], users: [], nextUserId: 100 };
const resetDb = () => {
  db.branches = [
    { id: 1, code: '01/1', branch_type: null },
    { id: 2, code: '10/2', branch_type: null },
    { id: 3, code: '01/2', branch_type: 'EASYGAS' },
  ];
  db.users = [
    { id: 5, username: 'admin', role: 'ADMIN', branch_id: null, is_active: 1, is_super_admin: 1, full_name: 'Admin', phone: null },
    { id: 6, username: 'oldemployee', role: 'EMPLOYEE', branch_id: 1, is_active: 1, is_super_admin: 0, full_name: 'Legacy', phone: null },
    { id: 7, username: 'eg_karim_01_1', role: 'EMPLOYEE', branch_id: 1, is_active: 1, is_super_admin: 0, full_name: 'Karim', phone: null },
  ];
  db.nextUserId = 100;
};

// ── transactional connection fake ──
const makeConnection = () => {
  let snapshot = null;
  return {
    async beginTransaction() { snapshot = JSON.parse(JSON.stringify({ branches: db.branches, users: db.users })); },
    async commit() { snapshot = null; },
    async rollback() { if (snapshot) { db.branches = snapshot.branches; db.users = snapshot.users; snapshot = null; } },
    release() {},
    async execute(sql, params = []) {
      if (/SELECT id FROM users WHERE username/.test(sql)) {
        return [db.users.filter((u) => u.username === params[0]).map((u) => ({ id: u.id }))];
      }
      if (/SELECT id, username, role, branch_id FROM users WHERE id/.test(sql)) {
        return [db.users.filter((u) => u.id === Number(params[0]))];
      }
      if (/SELECT id, code, branch_type FROM branches WHERE id = \? FOR UPDATE/.test(sql)) {
        return [db.branches.filter((b) => b.id === Number(params[0])).map((b) => ({ ...b }))];
      }
      if (/UPDATE branches SET branch_type = \? WHERE id = \? AND branch_type IS NULL/.test(sql)) {
        const b = db.branches.find((x) => x.id === Number(params[1]));
        if (b && b.branch_type === null) { b.branch_type = params[0]; return [{ affectedRows: 1 }]; }
        return [{ affectedRows: 0 }];
      }
      if (/SELECT branch_type FROM branches WHERE id/.test(sql)) {
        return [db.branches.filter((b) => b.id === Number(params[0])).map((b) => ({ branch_type: b.branch_type }))];
      }
      if (/INSERT INTO users/.test(sql)) {
        const id = db.nextUserId++;
        db.users.push({ id, full_name: params[0], username: params[1], password: params[2], phone: params[3], branch_id: params[4], role: params[5], is_active: 1, is_super_admin: 0 });
        return [{ insertId: id, affectedRows: 1 }];
      }
      if (/UPDATE users SET full_name = \?, phone = \?, branch_id = \? WHERE id/.test(sql)) {
        const u = db.users.find((x) => x.id === Number(params[3]));
        if (!u) return [{ affectedRows: 0 }];
        u.full_name = params[0]; u.phone = params[1]; u.branch_id = params[2];
        return [{ affectedRows: 1 }];
      }
      if (/SELECT is_active, role, is_super_admin FROM users WHERE id/.test(sql)) {
        return [db.users.filter((u) => u.id === Number(params[0])).map((u) => ({ is_active: u.is_active, role: u.role, is_super_admin: u.is_super_admin }))];
      }
      throw new Error(`fake connection: unhandled SQL: ${sql}`);
    },
  };
};
pool.execute = (sql, params) => makeConnection().execute(sql, params); // verifyToken path
pool.getConnection = async () => makeConnection();

const tokenFor = (id) => jwt.sign({ id, username: `u${id}` }, process.env.JWT_SECRET);
const branch = (id) => db.branches.find((b) => b.id === id);

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/users', require('../routes/userRoutes'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(resetDb);

const createUser = (body, actorId = 5) =>
  fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(actorId)}` },
    body: JSON.stringify({ full_name: 'T', password: 'secret1', ...body }),
  });
const updateUser = (id, body, actorId = 5) =>
  fetch(`${base}/api/users/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(actorId)}` },
    body: JSON.stringify({ full_name: 'T', ...body }),
  });

// ── §32 create ──
test('32.11 eg username + NULL branch → branch becomes EASYGAS + user created', async () => {
  const res = await createUser({ username: 'eg_ali_01_1', branch_id: 1 });
  assert.equal(res.status, 201);
  assert.equal(branch(1).branch_type, 'EASYGAS');
  assert.ok(db.users.some((u) => u.username === 'eg_ali_01_1' && u.branch_id === 1 && u.role === 'EMPLOYEE'));
});

test('32.12 st username classifies STAG_SERVICE', async () => {
  const res = await createUser({ username: 'st_sardor_10_2', branch_id: 2 });
  assert.equal(res.status, 201);
  assert.equal(branch(2).branch_type, 'STAG_SERVICE');
});

test('32.13 bs username classifies OTHER_SERVICE (multi-token human part)', async () => {
  const res = await createUser({ username: 'bs_service_master_10_2', branch_id: 2 });
  assert.equal(res.status, 201);
  assert.equal(branch(2).branch_type, 'OTHER_SERVICE');
});

test('32.14 branch already matching type → proceeds, type untouched', async () => {
  const res = await createUser({ username: 'eg_sardor_01_2', branch_id: 3 }); // branch 3 already EASYGAS
  assert.equal(res.status, 201);
  assert.equal(branch(3).branch_type, 'EASYGAS');
});

test('32.15 username branch code mismatch rejected (eg_ali_10_1 vs branch 01/1)', async () => {
  const res = await createUser({ username: 'eg_ali_10_1', branch_id: 1 });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errorCode, 'USERNAME_BRANCH_MISMATCH');
  assert.equal(branch(1).branch_type, null);
});

test('32.16/17 established type conflict → 409 BRANCH_TYPE_CONFLICT, user NOT created, type NOT overwritten', async () => {
  const res = await createUser({ username: 'st_vali_01_2', branch_id: 3 }); // branch 3 = EASYGAS
  assert.equal(res.status, 409);
  assert.equal((await res.json()).errorCode, 'BRANCH_TYPE_CONFLICT');
  assert.equal(branch(3).branch_type, 'EASYGAS'); // never flipped (§11)
  assert.ok(!db.users.some((u) => u.username === 'st_vali_01_2')); // no user (§10)
});

test('32.18 a failure AFTER classification rolls the classification back too (one business operation)', async () => {
  // duplicate-username INSERT failure path: pre-check passes (we bypass it by
  // colliding on the INSERT itself) — simulate by making the username exist
  // only after the pre-check via direct service call + forced throw.
  const conn = makeConnection();
  await conn.beginTransaction();
  await managedEmployeeService.enforceForCreate(conn, { role: 'EMPLOYEE', username: 'eg_new_01_1', branchId: 1 });
  assert.equal(branch(1).branch_type, 'EASYGAS'); // classified inside tx
  await conn.rollback(); // user INSERT failed → whole operation rolls back
  assert.equal(branch(1).branch_type, null); // classification did not survive alone
});

test('32.19 invalid managed username does not alter any branch', async () => {
  const res = await createUser({ username: 'xx_ali_01_1', branch_id: 1 });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errorCode, 'INVALID_EMPLOYEE_USERNAME_PREFIX');
  const res2 = await createUser({ username: 'notmanaged', branch_id: 1 });
  assert.equal(res2.status, 400);
  assert.equal((await res2.json()).errorCode, 'INVALID_EMPLOYEE_USERNAME_FORMAT');
  assert.equal(branch(1).branch_type, null);
});

test('32.19b managed username WITHOUT a branch → USERNAME_BRANCH_REQUIRED; non-managed without branch stays allowed', async () => {
  const res = await createUser({ username: 'eg_ali_01_1' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errorCode, 'USERNAME_BRANCH_REQUIRED');
  const res2 = await createUser({ username: 'plainname' }); // unassigned-employee state preserved
  assert.equal(res2.status, 201);
});

test('32.20 ADMIN accounts are exempt from the convention (service-level: role guard)', async () => {
  const conn = makeConnection();
  const out = await managedEmployeeService.enforceForCreate(conn, { role: 'ADMIN', username: 'plainadmin', branchId: null });
  assert.deepEqual(out, { parsed: null, classification: null });
});

test('32.21 legacy employee authentication path is untouched (auth never parses usernames)', async () => {
  // A token for the LEGACY-named employee (id 6, username "oldemployee")
  // authenticates fine — verifyToken resolves the stored user and only the
  // ADMIN role gate rejects the admin-only route: 403, never 401.
  const res = await createUser({ username: 'whatever_x_01_1' }, 6);
  assert.equal(res.status, 403);
  const src = require('node:fs').readFileSync(require.resolve('../controllers/authController.js'), 'utf8');
  assert.ok(!src.includes('parseManagedEmployeeUsername'), 'login must never parse usernames');
  const auth = require('node:fs').readFileSync(require.resolve('../middleware/auth.js'), 'utf8');
  assert.ok(!auth.includes('parseManagedEmployeeUsername'), 'verifyToken must never parse usernames');
});

// ── §33 update / move ──
test('33.22 unrelated edit (phone/name) to a LEGACY employee succeeds, nothing classified', async () => {
  const res = await updateUser(6, { phone: '+998901112233', branch_id: 1 }); // same branch — unchanged
  assert.equal(res.status, 200);
  assert.equal(branch(1).branch_type, null);
});

test('33.24/25 branch move with matching suffix classifies the TARGET atomically', async () => {
  db.users.push({ id: 8, username: 'st_jasur_10_2', role: 'EMPLOYEE', branch_id: null, is_active: 1, is_super_admin: 0, full_name: 'J', phone: null });
  const res = await updateUser(8, { branch_id: 2 });
  assert.equal(res.status, 200);
  assert.equal(branch(2).branch_type, 'STAG_SERVICE');
});

test('33.26 old branch classification preserved after a move', async () => {
  branch(2).branch_type = null;
  db.users.push({ id: 9, username: 'eg_mover_10_2', role: 'EMPLOYEE', branch_id: 3, is_active: 1, is_super_admin: 0, full_name: 'M', phone: null });
  const res = await updateUser(9, { branch_id: 2 });
  assert.equal(res.status, 200);
  assert.equal(branch(2).branch_type, 'EASYGAS'); // target classified
  assert.equal(branch(3).branch_type, 'EASYGAS'); // old branch untouched
});

test('33.27 prefix conflict on target branch rejected on move', async () => {
  db.users.push({ id: 10, username: 'st_conf_01_2', role: 'EMPLOYEE', branch_id: null, is_active: 1, is_super_admin: 0, full_name: 'C', phone: null });
  const res = await updateUser(10, { branch_id: 3 }); // branch 3 EASYGAS, username st_
  assert.equal(res.status, 409);
  assert.equal((await res.json()).errorCode, 'BRANCH_TYPE_CONFLICT');
  const u = db.users.find((x) => x.id === 10);
  assert.equal(u.branch_id, null); // move rolled back with the conflict
});

test('33.28 branch change whose code disagrees with the username suffix rejected', async () => {
  const res = await updateUser(7, { branch_id: 2 }); // eg_karim_01_1 → branch 10/2
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errorCode, 'USERNAME_BRANCH_MISMATCH');
});

test('33.28b LEGACY employee branch CHANGE rejected with the DEDICATED explanatory code (Beta-2.1)', async () => {
  const res = await updateUser(6, { branch_id: 2 });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errorCode, 'LEGACY_EMPLOYEE_BRANCH_CHANGE'); // not a misleading generic format error
  assert.equal(db.users.find((u) => u.id === 6).branch_id, 1); // unchanged
});

test('33.23/29 username & role are immutable via this API — the service still validates them if ever passed', async () => {
  // API surface: PUT only reads full_name/phone/branch_id (username/role
  // changes and role→EMPLOYEE conversions cannot happen through it).
  const src = require('node:fs').readFileSync(require.resolve('../controllers/userController.js'), 'utf8');
  assert.match(src, /const \{ full_name, phone, branch_id \} = req\.body/);
  // Service-level: a managed-name change would re-validate against the branch:
  const conn = makeConnection();
  await conn.beginTransaction();
  await assert.rejects(
    () => managedEmployeeService.enforceForUpdate(conn, { existingUser: { id: 7, username: 'eg_karim_01_1', role: 'EMPLOYEE', branch_id: 1 }, newBranchId: 2 }),
    (e) => e.errorCode === 'USERNAME_BRANCH_MISMATCH'
  );
  await conn.rollback();
});

test('33.30 deleting/disabling a user never declassifies a branch (no declassification code path exists)', async () => {
  const src = require('node:fs').readFileSync(require.resolve('../services/managedEmployeeService.js'), 'utf8');
  assert.ok(!/branch_type\s*=\s*NULL/i.test(src.replace(/IS NULL/gi, '')), 'service must never write branch_type back to NULL');
  const ctrl = require('node:fs').readFileSync(require.resolve('../controllers/userController.js'), 'utf8');
  assert.ok(!/branch_type/.test(ctrl.split('setUserActive')[1] || ''), 'disable/enable path must not touch branch_type');
});

// ── §34 concurrency ──
test('34.31 concurrent first classification: exactly one wins, the conflicting request FAILS — never last-write-wins', async () => {
  // Model the race: the loser's FOR UPDATE read saw NULL (stale), the
  // winner's EASYGAS commit lands first; the loser's conditional UPDATE
  // (`WHERE branch_type IS NULL`) then matches 0 rows and the re-read shows
  // the winner — the service must throw, never overwrite.
  const staleConn = makeConnection();
  const realExecute = staleConn.execute.bind(staleConn);
  staleConn.execute = async (sql, params) => {
    if (/FOR UPDATE/.test(sql)) {
      return [[{ id: 1, code: '01/1', branch_type: null }]]; // stale NULL view
    }
    return realExecute(sql, params);
  };
  branch(1).branch_type = 'EASYGAS'; // the eg_ winner already committed
  await assert.rejects(
    () => managedEmployeeService.enforceForCreate(staleConn, { role: 'EMPLOYEE', username: 'st_vali_01_1', branchId: 1 }),
    (e) => e.errorCode === 'BRANCH_TYPE_CONFLICT'
  );
  assert.equal(branch(1).branch_type, 'EASYGAS'); // winner survives untouched
  // and an identical concurrent classification (eg_ vs eg_) is accepted quietly:
  const out = await managedEmployeeService.enforceForCreate(staleConn, { role: 'EMPLOYEE', username: 'eg_dup_01_1', branchId: 1 });
  assert.equal(out.classification, null);
});
