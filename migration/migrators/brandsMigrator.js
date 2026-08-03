/**
 * brands <- stag-db/product_brands.sql
 *
 * Direct rename-only mapping (see the migration-analysis conversation):
 *   id         -> external_id (idempotency key)
 *   name       -> name
 *   full_name  -> full_name
 *   country    -> country
 *   logo       -> logo_url
 * Ignored: country_ru, sales_count (no EZONE equivalent).
 * Generated: is_active=TRUE, synced_at=NULL (a dead/deprecated column —
 * this is a manual historical import, not a live sync run).
 *
 * Returns oldBrandIdToName ({ old product_brands.id -> name }) so
 * productsMigrator can resolve products.product_brand_id through it.
 */

const path = require('path');
const { parseDumpFile } = require('../dumpParser');
const { withTransaction } = require('../withTransaction');

const STAG_DB_DIR = path.join(__dirname, '..', '..', '..', 'stag-db');

async function migrateBrands(connection, reporter) {
  const filePath = path.join(STAG_DB_DIR, 'product_brands.sql');
  const statements = parseDumpFile(filePath).filter((s) => s.table === 'product_brands');

  const [existingRows] = await connection.execute('SELECT external_id, name FROM brands');
  const existingByExternalId = new Set(existingRows.filter((r) => r.external_id).map((r) => r.external_id));
  // A brand with the same NAME but a different (or no) external_id is a
  // real duplicate risk — e.g. an admin already created "STAG" by hand
  // before this migration ran. Inserting a second "STAG" row would split
  // future brand_id references across two rows with the same name.
  const existingByName = new Set(existingRows.map((r) => r.name.trim().toUpperCase()));

  const oldBrandIdToName = {};

  for (const { record } of statements) {
    oldBrandIdToName[record.id] = record.name;
    const externalId = String(record.id);
    const nameKey = record.name.trim().toUpperCase();

    if (existingByExternalId.has(externalId)) {
      reporter.skipped('brands', { external_id: externalId, name: record.name }, 'external_id already exists');
      continue;
    }
    if (existingByName.has(nameKey)) {
      reporter.skipped('brands', { external_id: externalId, name: record.name }, 'a brand with this name already exists under a different external_id — skipped to avoid a duplicate; verify manually whether this is the same brand');
      continue;
    }

    const { ok, error } = await withTransaction(connection, () => connection.execute(
      `INSERT INTO brands (external_id, name, full_name, country, logo_url, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, TRUE, ?, ?)`,
      [externalId, record.name, record.full_name, record.country, record.logo, record.created_at, record.updated_at]
    ));

    if (ok) {
      existingByExternalId.add(externalId);
      existingByName.add(nameKey);
      reporter.imported('brands', { external_id: externalId, name: record.name });
    } else {
      reporter.failed('brands', { external_id: externalId, name: record.name }, error.message);
    }
  }

  return oldBrandIdToName;
}

module.exports = { migrateBrands };
