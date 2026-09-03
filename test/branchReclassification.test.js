/**
 * Explicit branch reclassification (Beta-2.1, §17-§18). node:test — real
 * routes/branchRoutes.js + middleware/auth.js + branchController +
 * managedEmployeeService.reclassifyBranch over a transactional in-memory
 * fake. Proves authorization (Super-Admin only), evidence-based consistency,
 * NULL-reset rules, rollback, audit, and the onboarding⇄reclassification
 * serialization invariant.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'beta21-test-secret';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../config/database');
const managedEmployeeService = require('../services/managedEmployeeService');

const db = { branches: [], users: [], failNextUsersQuery: false };
const resetDb = () => {
  db.branches = [
    { id: 1, code: '01/1', branch_type: 'EASYGAS' },
    { id: 2, code: '10/2', branch_type: null },
  ];
  db.users = [
    { id: 1, username: 'eg_worker_01_1', role: 'EMPLOYEE', branch_id: null, is_active: 1, is_super_admin: 0 },
    { id: 2, username: 'plainadmin', role: 'ADMIN', branch_id: null, is_active: 1, is_super_admin: 0 },
    { id: 3, username: 'superadmin', role: 'ADMIN', branch_id: null, is_active: 1, is_super_admin: 1 },
  ];
  db.failNextUsersQuery = false;
};

const makeConnection = () => {
  let snapshot = null;
  return {
    async beginTransaction() { snapshot = JSON.parse(JSON.stringify({ branches: db.branches, users: db.users })); },
    async commit() { snapshot = null; },
    async rollback() { if (snapshot) { db.branches = snapshot.branches; db.users = snapshot.users; snapshot = null; } },
    release() {},
    async execute(sql, params = []) {
      if (/SELECT id, code, branch_type FROM branches WHERE id = \? FOR UPDATE/.test(sql)) {
        return [db.branches.filter((b) => b.id === Number(params[0])).map((b) => ({ ...b }))];
      }
      if (/SELECT id, username, is_active FROM users WHERE branch_id/.test(sql)) {
        if (db.failNextUsersQuery) { db.failNextUsersQuery = false; throw new Error('simulated DB failure'); }
        return [db.users.filter((u) => u.branch_id === Number(params[0]) && u.role === 'EMPLOYEE').map((u) => ({ ...u }))];
      }
      if (/UPDATE branches SET branch_type = \? WHERE id = \? AND branch_type IS NULL/.test(sql)) {
        const b = db.branches.find((x) => x.id === Number(params[1]));
        if (b && b.branch_type === null) { b.branch_type = params[0]; return [{ affectedRows: 1 }]; }
        return [{ affectedRows: 0 }];
      }
      if (/UPDATE branches SET branch_type = \? WHERE id = \?$/.test(sql.trim())) {
        const b = db.branches.find((x) => x.id === Number(params[1]));
        if (!b) return [{ affectedRows: 0 }];
        b.branch_type = params[0];
        return [{ affectedRows: 1 }];
      }
      if (/SELECT branch_type FROM branches WHERE id/.test(sql)) {
        return [db.branches.filter((b) => b.id === Number(params[0])).map((b) => ({ branch_type: b.branch_type }))];
      }
      if (/SELECT is_active, role, is_super_admin FROM users WHERE id/.test(sql)) {
        return [db.users.filter((u) => u.id === Number(params[0])).map((u) => ({ is_active: u.is_active, role: u.role, is_super_admin: u.is_super_admin }))];
      }
      throw new Error(`fake connection: unhandled SQL: ${sql}`);
    },
  };
};
pool.execute = (sql, params) => makeConnection().execute(sql, params);
pool.getConnection = async () => makeConnection();

const tokenFor = (id) => jwt.sign({ id, username: `u${id}` }, process.env.JWT_SECRET);
const branch = (id) => db.branches.find((b) => b.id === id);
const assign = (userId, branchId) => { db.users.find((u) => u.id === userId).branch_id = branchId; };

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/branches', require('../routes/branchRoutes'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(resetDb);

const reclassify = (id, branchType, actorId = 3, withAuth = true) =>
  fetch(`${base}/api/branches/${id}/reclassify`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(withAuth ? { Authorization: `Bearer ${tokenFor(actorId)}` } : {}) },
    body: JSON.stringify({ branch_type: branchType }),
  });

test('17.13 unauthenticated rejected (401)', async () => {
  assert.equal((await reclassify(1, 'STAG_SERVICE', 3, false)).status, 401);
});

test('17.14 EMPLOYEE rejected (403)', async () => {
  assert.equal((await reclassify(1, 'STAG_SERVICE', 1)).status, 403);
});

test('17.15 plain ADMIN rejected, Super-Admin allowed (chosen policy: requireSuperAdmin)', async () => {
  assert.equal((await reclassify(1, 'STAG_SERVICE', 2)).status, 403);
  assert.equal((await reclassify(1, 'STAG_SERVICE', 3)).status, 200);
});

test('17.16/17 valid correction with no assigned employees succeeds with correct old/new values', async () => {
  const res = await reclassify(1, 'STAG_SERVICE');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.old_type, 'EASYGAS');
  assert.equal(body.new_type, 'STAG_SERVICE');
  assert.equal(body.changed, true);
  assert.equal(branch(1).branch_type, 'STAG_SERVICE');
});

test('17.18 invalid target type rejected (400), 17.19 unknown branch rejected (404)', async () => {
  assert.equal((await reclassify(1, 'THIRD_PARTY')).status, 400);
  assert.equal((await reclassify(1, 'FOO')).status, 400);
  const res = await reclassify(999, 'EASYGAS');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).errorCode, 'BRANCH_NOT_FOUND');
});

test('17.20 managed same-type employees: reclassify to the SAME type is a safe no-op', async () => {
  assign(1, 1); // eg_worker_01_1 on branch 01/1 (EASYGAS)
  const res = await reclassify(1, 'EASYGAS');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).changed, false);
  assert.equal(branch(1).branch_type, 'EASYGAS');
});

test('17.21/22/26 conflicting managed employee(s) block reclassification; original type unchanged', async () => {
  assign(1, 1);
  db.users.push({ id: 9, username: 'eg_second_01_1', role: 'EMPLOYEE', branch_id: 1, is_active: 0, is_super_admin: 0 }); // even DISABLED counts (conservative)
  const res = await reclassify(1, 'STAG_SERVICE');
  assert.equal(res.status, 409);
  assert.equal((await res.json()).errorCode, 'BRANCH_RECLASSIFICATION_CONFLICT');
  assert.equal(branch(1).branch_type, 'EASYGAS');
});

test('17.23 legacy-only employees provide no evidence — correction allowed', async () => {
  db.users.push({ id: 10, username: 'oldtimer', role: 'EMPLOYEE', branch_id: 1, is_active: 1, is_super_admin: 0 });
  const res = await reclassify(1, 'OTHER_SERVICE');
  assert.equal(res.status, 200);
  assert.equal(branch(1).branch_type, 'OTHER_SERVICE');
});

test('17.24 reset to NULL allowed with no managed employees, 17.25 blocked when a managed employee establishes a type', async () => {
  assert.equal((await reclassify(1, null)).status, 200);
  assert.equal(branch(1).branch_type, null);
  branch(1).branch_type = 'EASYGAS';
  assign(1, 1);
  const res = await reclassify(1, null);
  assert.equal(res.status, 409);
  assert.equal(branch(1).branch_type, 'EASYGAS');
});

test('17.27/28 employees are never renamed or moved by reclassification', async () => {
  db.users.push({ id: 11, username: 'oldtimer', role: 'EMPLOYEE', branch_id: 1, is_active: 1, is_super_admin: 0 });
  await reclassify(1, 'STAG_SERVICE');
  assert.equal(db.users.find((u) => u.id === 11).username, 'oldtimer');
  assert.equal(db.users.find((u) => u.id === 11).branch_id, 1);
});

test('17.29 audit line emitted with action, actor, branch, old/new', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await reclassify(1, 'STAG_SERVICE');
  } finally {
    console.log = orig;
  }
  const audit = lines.find((l) => l.includes('action=BRANCH_RECLASSIFICATION'));
  assert.ok(audit, 'audit line missing');
  assert.ok(audit.includes('01/1') && audit.includes('EASYGAS -> STAG_SERVICE') && audit.includes('#3'));
});

test('17.30 mid-operation DB failure rolls back — original type untouched, 500 surfaced', async () => {
  db.failNextUsersQuery = true;
  const res = await reclassify(1, 'STAG_SERVICE');
  assert.equal(res.status, 500);
  assert.equal(branch(1).branch_type, 'EASYGAS');
});

test('18 concurrency invariant: no committed state can pair a reclassified type with a contradicting managed employee', async () => {
  // Ordering 1 — onboarding commits first: the reclassifier's evidence read
  // happens under the SAME branch row lock, so it sees the new employee and
  // must fail.
  assign(1, 1); // eg_worker_01_1 committed on 01/1
  assert.equal((await reclassify(1, 'STAG_SERVICE')).status, 409);
  assert.equal(branch(1).branch_type, 'EASYGAS');

  // Ordering 2 — reclassification commits first: branch is now STAG_SERVICE,
  // and the eg_ onboarding (same FOR UPDATE lock) must fail with
  // BRANCH_TYPE_CONFLICT — the employee is never created.
  resetDb();
  assert.equal((await reclassify(1, 'STAG_SERVICE')).status, 200);
  const conn = makeConnection();
  await conn.beginTransaction();
  await assert.rejects(
    () => managedEmployeeService.enforceForCreate(conn, { role: 'EMPLOYEE', username: 'eg_new_01_1', branchId: 1 }),
    (e) => e.errorCode === 'BRANCH_TYPE_CONFLICT'
  );
  await conn.rollback();
  assert.equal(branch(1).branch_type, 'STAG_SERVICE');
  assert.ok(!db.users.some((u) => u.username === 'eg_new_01_1'));
});
