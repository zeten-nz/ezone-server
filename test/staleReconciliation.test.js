/**
 * Stale EasyGas product reconciliation (§13). Uses node:test with a mocked pool + stubbed catalog client — no live DB.
 * Proves the critical safety properties: reconciliation runs ONLY after a complete successful /products pull, is
 * fail-safe on an empty pull, soft-disables absent products (never DELETE), and is reactivation-safe.
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const client = require('../services/easyGasCatalogClient');
const svc = require('../services/easyGasCatalogSyncService');

const origGetProducts = client.getProducts;
afterEach(() => { client.getProducts = origGetProducts; });

// Fake pool: dispatches on the SQL and records every call so tests can assert what ran.
function makePool() {
  const calls = [];
  return {
    calls,
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT NOW\(\)/.test(sql)) return [[{ startedAt: new Date() }]];
      if (/FROM sync_state WHERE sync_key/.test(sql)) return [[]];                 // getSyncCheckpoint
      if (/SELECT id, name FROM brands/.test(sql)) return [[{ id: 1, name: 'BrandX' }]]; // resolveBrandById
      if (/INSERT INTO products/.test(sql)) return [{ affectedRows: 1 }];          // upsertProduct
      if (/UPDATE products SET is_active = FALSE/.test(sql)) return [{ affectedRows: (params || []).length }]; // reconcile
      if (/INSERT INTO sync_state/.test(sql)) return [{}];                          // setSyncCheckpoint
      return [[]];
    },
  };
}
const reconcileCalls = (pool) => pool.calls.filter((c) => /UPDATE products SET is_active = FALSE/.test(c.sql));

// A CONTROLLER product (product_category_id 4 → CONTROLLER via config/externalCategoryMap).
const P = (id, categoryId = 4) => ({ id, product_category_id: categoryId, product_brand_id: 7, name: `Ctrl ${id}`, station_type: null });

// pages: [{ rows, last_page } | { fail: 'network'|'http' }]
function stubProducts(pages) {
  client.getProducts = async ({ page }) => {
    const p = pages[page - 1];
    if (!p) return { ok: false, status: 500, data: null, networkError: false };
    if (p.fail === 'network') return { ok: false, status: 0, data: null, networkError: true };
    if (p.fail === 'http') return { ok: false, status: 500, data: null, networkError: false };
    return { ok: true, status: 200, data: { data: p.rows, last_page: p.last_page }, networkError: false };
  };
}

// ── reconcileStaleProducts (direct) ──
test('reconcile: soft-disables active EasyGas products absent from the pull — is_active=FALSE, never DELETE (§13.2/3/13)', async () => {
  const pool = makePool();
  const n = await svc.reconcileStaleProducts(pool, new Set(['100', '200']));
  const rc = reconcileCalls(pool);
  assert.equal(rc.length, 1);
  assert.match(rc[0].sql, /UPDATE products SET is_active = FALSE/);
  assert.match(rc[0].sql, /external_id IS NOT NULL/);
  assert.match(rc[0].sql, /is_active = TRUE/);
  assert.match(rc[0].sql, /external_id NOT IN \(\?,\?\)/);
  assert.doesNotMatch(rc[0].sql, /\bDELETE\b/i);
  assert.deepEqual(rc[0].params, ['100', '200']);
  assert.equal(n, 2);
});

test('reconcile: empty seen set deactivates NOTHING (fail-safe, §13.11)', async () => {
  const pool = makePool();
  const n = await svc.reconcileStaleProducts(pool, new Set());
  assert.equal(reconcileCalls(pool).length, 0);
  assert.equal(n, 0);
});

test('reconcile: a product present again in the pull (seen) is preserved — reactivation-safe (§13.7)', async () => {
  const pool = makePool();
  // 375 is back in the catalog → it is in the NOT IN list, so it is never deactivated (and upsert reactivates it).
  await svc.reconcileStaleProducts(pool, new Set(['375']));
  assert.deepEqual(reconcileCalls(pool)[0].params, ['375']);
});

// ── syncProducts gating (mocked client + pool) ──
test('syncProducts: full successful pull runs reconciliation with exactly the seen external_ids (§13.1/2)', async () => {
  stubProducts([{ rows: [P('100'), P('200')], last_page: 2 }, { rows: [P('300')], last_page: 2 }]);
  const pool = makePool();
  const res = await svc.syncProducts(pool);
  assert.equal(res.ok, true);
  const rc = reconcileCalls(pool);
  assert.equal(rc.length, 1);
  assert.deepEqual([...rc[0].params].sort(), ['100', '200', '300']);
});

test('syncProducts: product D absent from the pull is NOT in the seen set → the UPDATE will deactivate it (§13.2)', async () => {
  // Catalog returns 362/381/365 (reducer/cylinder/injector present) but NOT 375 (the real failing controller).
  stubProducts([{ rows: [P('362', 11), P('381', 28), P('365', 17)], last_page: 1 }]);
  const pool = makePool();
  await svc.syncProducts(pool);
  const rc = reconcileCalls(pool)[0];
  assert.ok(!rc.params.includes('375')); // 375 absent → the WHERE ... NOT IN(seen) matches (and deactivates) it
  assert.deepEqual([...rc.params].sort(), ['362', '365', '381']);
});

test('syncProducts: network failure mid-pull → ZERO deactivations (§13.8)', async () => {
  stubProducts([{ rows: [P('100')], last_page: 2 }, { fail: 'network' }]);
  const pool = makePool();
  const res = await svc.syncProducts(pool);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'network');
  assert.equal(reconcileCalls(pool).length, 0);
});

test('syncProducts: HTTP failure → ZERO deactivations (§13.9)', async () => {
  stubProducts([{ fail: 'http' }]);
  const pool = makePool();
  const res = await svc.syncProducts(pool);
  assert.equal(res.ok, false);
  assert.equal(reconcileCalls(pool).length, 0);
});

test('syncProducts: page-2 pagination failure → ZERO deactivations (§13.10)', async () => {
  stubProducts([{ rows: [P('100')], last_page: 3 }, { fail: 'http' }]);
  const pool = makePool();
  const res = await svc.syncProducts(pool);
  assert.equal(res.ok, false);
  assert.equal(reconcileCalls(pool).length, 0);
});

test('syncProducts: malformed 200 body (no rows) → ZERO deactivations (§13.11)', async () => {
  client.getProducts = async () => ({ ok: true, status: 200, data: { garbage: true }, networkError: false });
  const pool = makePool();
  const res = await svc.syncProducts(pool);
  assert.equal(res.ok, true);
  assert.equal(reconcileCalls(pool).length, 0); // extractRows → [], seen empty → fail-safe skip
});

test('syncProducts: empty successful pull → ZERO deactivations (guard, §13.11)', async () => {
  stubProducts([{ rows: [], last_page: 1 }]);
  const pool = makePool();
  const res = await svc.syncProducts(pool);
  assert.equal(res.ok, true);
  assert.equal(reconcileCalls(pool).length, 0);
});

test('syncProducts: never issues a DELETE and never touches brands/cars (§13.12/13)', async () => {
  stubProducts([{ rows: [P('100')], last_page: 1 }]);
  const pool = makePool();
  await svc.syncProducts(pool);
  assert.ok(pool.calls.every((c) => !/\bDELETE\b/i.test(c.sql)));                 // no catalog delete
  assert.ok(pool.calls.every((c) => !/FROM cars|INTO cars|UPDATE cars/i.test(c.sql))); // products sync doesn't sync cars
});

test('upsert reactivation: syncProducts upsert forces is_active=TRUE (restores a previously-disabled product, §13.7)', async () => {
  stubProducts([{ rows: [P('375')], last_page: 1 }]);
  const pool = makePool();
  await svc.syncProducts(pool);
  const upserts = pool.calls.filter((c) => /INSERT INTO products/.test(c.sql));
  assert.ok(upserts.length >= 1);
  assert.match(upserts[0].sql, /is_active = TRUE/); // ON DUPLICATE KEY UPDATE ... is_active = TRUE
});

// ── selection guard already enforced by the backend (§13.5) ──
test('product search excludes inactive products — is_active = TRUE filter (§13.5)', async () => {
  const productRepo = require('../repositories/productRepository');
  const captured = [];
  const conn = { execute: async (sql, params) => { captured.push({ sql, params }); return [[]]; } };
  await productRepo.search(conn, { query: 'x', categories: ['CONTROLLER'] });
  assert.equal(captured.length, 1);
  assert.match(captured[0].sql, /is_active = TRUE/); // a deactivated product can never appear in the warranty picker
});
