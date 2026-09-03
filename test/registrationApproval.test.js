/**
 * Registration approval hardening (Beta-2.1, §16). node:test — real
 * routes/registrationRequestRoutes.js + middleware/auth.js +
 * controllers/registrationRequestController.js + the SAME
 * managedEmployeeService, against a transactional in-memory DB fake.
 * Proves: no public applicant username can become an unmanaged final
 * EMPLOYEE; approval runs the one authoritative classification rule inside
 * one transaction; historical request rows stay readable.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'beta21-test-secret';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../config/database');

const db = { branches: [], users: [], requests: [], nextId: 100 };
const resetDb = () => {
  db.branches = [
    { id: 1, code: '01/1', branch_type: null },
    { id: 2, code: '10/2', branch_type: null },
    { id: 3, code: '01/2', branch_type: 'EASYGAS' },
  ];
  db.users = [
    { id: 5, username: 'admin', role: 'ADMIN', branch_id: null, is_active: 1, is_super_admin: 0 },
  ];
  db.requests = [
    { id: 40, first_name: 'Ali', last_name: 'Applicant', username: 'ali_applicant', password_hash: 'H', phone: '+998901234567', region: 'R', district: 'D', branch_id: 1, branch_code: '01/1', photo_filename: null, status: 'PENDING', notes: null },
    { id: 41, first_name: 'Vali', last_name: 'V', username: 'vali99', password_hash: 'H', phone: '+998901234568', region: 'R', district: 'D', branch_id: 3, branch_code: '01/2', photo_filename: null, status: 'PENDING', notes: null },
  ];
  db.nextId = 100;
};

const makeConnection = () => {
  let snapshot = null;
  return {
    async beginTransaction() { snapshot = JSON.parse(JSON.stringify({ branches: db.branches, users: db.users, requests: db.requests })); },
    async commit() { snapshot = null; },
    async rollback() { if (snapshot) { db.branches = snapshot.branches; db.users = snapshot.users; db.requests = snapshot.requests; snapshot = null; } },
    release() {},
    async execute(sql, params = []) {
      if (/SELECT \* FROM registration_requests WHERE id/.test(sql)) {
        return [db.requests.filter((r) => r.id === Number(params[0])).map((r) => ({ ...r }))];
      }
      if (/FROM registration_requests rr[\s\S]*WHERE rr\.id/.test(sql)) {
        return [db.requests.filter((r) => r.id === Number(params[0])).map((r) => ({ ...r, branch_name: null, reviewer_name: null }))];
      }
      if (/SELECT id FROM users WHERE username/.test(sql)) {
        return [db.users.filter((u) => u.username === params[0]).map((u) => ({ id: u.id }))];
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
        // 13-column approval INSERT: username at index 3, branch_id at 8, branch_code at 9
        const id = db.nextId++;
        db.users.push({ id, full_name: params[0], username: params[3], role: params[11], branch_id: params[8], branch_code: params[9], is_active: 1, is_super_admin: 0 });
        return [{ insertId: id, affectedRows: 1 }];
      }
      if (/UPDATE registration_requests SET status = \?, reviewed_at/.test(sql)) {
        const r = db.requests.find((x) => x.id === Number(params[2]) && x.status === params[3]);
        if (!r) return [{ affectedRows: 0 }];
        r.status = params[0]; r.reviewed_by = params[1];
        return [{ affectedRows: 1 }];
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
const request = (id) => db.requests.find((r) => r.id === id);

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/registration-requests', require('../routes/registrationRequestRoutes'));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(resetDb);

const approve = (id, body = {}) =>
  fetch(`${base}/api/registration-requests/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(5)}` },
    body: JSON.stringify(body),
  });

test('16.1/8/9 approval WITHOUT a managed override fails — applicant username can never become an unmanaged EMPLOYEE; nothing partially created/classified', async () => {
  const res = await approve(40); // applicant chose "ali_applicant", branch 01/1
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errorCode, 'INVALID_EMPLOYEE_USERNAME_FORMAT');
  assert.ok(!db.users.some((u) => u.username === 'ali_applicant'));
  assert.equal(branch(1).branch_type, null);         // no partial classification
  assert.equal(request(40).status, 'PENDING');       // request untouched, still actionable
});

test('16.2/3 approval with an admin-supplied eg username creates the employee and classifies the NULL branch EASYGAS', async () => {
  const res = await approve(40, { username: 'eg_ali_01_1' });
  assert.equal(res.status, 200);
  const created = db.users.find((u) => u.username === 'eg_ali_01_1');
  assert.ok(created);
  assert.equal(created.role, 'EMPLOYEE');
  assert.equal(created.branch_id, 1);
  assert.equal(created.branch_code, '01/1');
  assert.equal(branch(1).branch_type, 'EASYGAS');
  assert.equal(request(40).status, 'APPROVED');
});

test('16.4 st approval (with branch override) classifies STAG_SERVICE', async () => {
  const res = await approve(40, { username: 'st_ali_10_2', branch_id: 2 });
  assert.equal(res.status, 200);
  assert.equal(branch(2).branch_type, 'STAG_SERVICE');
  assert.equal(db.users.find((u) => u.username === 'st_ali_10_2').branch_id, 2);
});

test('16.5 bs approval classifies OTHER_SERVICE (multi-token human part)', async () => {
  const res = await approve(40, { username: 'bs_service_master_10_2', branch_id: 2 });
  assert.equal(res.status, 200);
  assert.equal(branch(2).branch_type, 'OTHER_SERVICE');
});

test('16.6 approval branch-code mismatch rejected', async () => {
  const res = await approve(40, { username: 'eg_ali_10_2' }); // request branch is 01/1
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errorCode, 'USERNAME_BRANCH_MISMATCH');
  assert.equal(request(40).status, 'PENDING');
});

test('16.7/9 approval branch-type conflict rejected — no user, no reclassification, request stays PENDING', async () => {
  const res = await approve(41, { username: 'st_vali_01_2' }); // branch 3 already EASYGAS
  assert.equal(res.status, 409);
  assert.equal((await res.json()).errorCode, 'BRANCH_TYPE_CONFLICT');
  assert.equal(branch(3).branch_type, 'EASYGAS');
  assert.ok(!db.users.some((u) => u.username === 'st_vali_01_2'));
  assert.equal(request(41).status, 'PENDING');
});

test('16.11 historical applicant record stays readable with the ORIGINAL applicant username after an overridden approval', async () => {
  await approve(40, { username: 'eg_ali_01_1' });
  const res = await fetch(`${base}/api/registration-requests/40`, { headers: { Authorization: `Bearer ${tokenFor(5)}` } });
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.username, 'ali_applicant'); // original applicant identity preserved on the request
  assert.equal(row.status, 'APPROVED');
});

test('16.x approval reuses the ONE classification service — no duplicated rule in this controller', () => {
  const src = require('node:fs').readFileSync(require.resolve('../controllers/registrationRequestController.js'), 'utf8');
  assert.ok(src.includes('managedEmployeeService.enforceForCreate'));
  assert.ok(!src.includes("split('_')"), 'controller must not parse usernames itself');
});
