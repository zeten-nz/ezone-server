/**
 * products <- stag-db/products.sql
 *
 *   id                    -> external_id (idempotency key)
 *   name                  -> model
 *   [product_category_id] -> category (see lookups.CATEGORY_MAP)
 *   [product_brand_id]    -> brand, brand_id (two-hop resolution, see below)
 *   [name text]           -> fuel_type (best-effort: "(metan)"/"CNG" -> 'CNG', else NULL)
 *
 * Ignored: name_ru, price, mxik, package_code, vat_percent, old_price,
 * image, description(_ru), station_type, is_universal, min/max_cylinders,
 * min/max_power_hp, fits_mpi/gdi/dual, aspiration_fit — the old e-commerce
 * pricing/tax/vehicle-fitment-compatibility model, none of which has any
 * equivalent in EZONE's warranty-equipment catalog.
 *
 * Generated: is_active=TRUE. score/status/serial_number/qr_code/synced_at
 * are left at their schema defaults — all four are documented DEAD columns
 * in EZONE, kept only for historical rows; not worth sourcing here.
 *
 * Rows whose product_category_id is in EXCLUDED_CATEGORY_IDS (engine
 * oils/antifreeze — not gas-conversion equipment) are skipped outright.
 *
 * brand_id resolution is two-hop: product_brand_id (old numeric id) looks
 * up a NAME via oldBrandIdToName (built while migrating product_brands.sql
 * -> brands, passed in from the orchestrator), and that name is then looked
 * up against EZONE's *own*, already-migrated brands table to get the real
 * new brand_id. A product with no product_brand_id at all in the source
 * (17 of 179 rows, verified) gets brand='UNSPECIFIED' + brand_id=NULL,
 * logged as a warning rather than silently guessed — EZONE's products.brand
 * is NOT NULL, so *something* has to go there.
 */

const path = require('path');
const { parseDumpFile } = require('../dumpParser');
const { CATEGORY_MAP, EXCLUDED_CATEGORY_IDS } = require('../lookups');
const { withTransaction } = require('../withTransaction');

const STAG_DB_DIR = path.join(__dirname, '..', '..', '..', 'stag-db');
const UNSPECIFIED_BRAND = 'UNSPECIFIED';

function resolveFuelType(name) {
  return /metan|\bCNG\b/i.test(name || '') ? 'CNG' : null;
}

function resolveBrand(record, oldBrandIdToName, brandNameToId, reporter, externalId) {
  if (record.product_brand_id == null) {
    reporter.warn(`products: external_id ${externalId} — no product_brand_id in source, brand defaulted to ${UNSPECIFIED_BRAND}`);
    return { brand: UNSPECIFIED_BRAND, brandId: null };
  }

  const oldBrandName = oldBrandIdToName[record.product_brand_id];
  if (!oldBrandName) {
    reporter.warn(`products: external_id ${externalId} — product_brand_id ${record.product_brand_id} has no matching row in product_brands.sql, brand defaulted to ${UNSPECIFIED_BRAND}`);
    return { brand: UNSPECIFIED_BRAND, brandId: null };
  }

  const resolvedId = brandNameToId.get(oldBrandName.trim().toUpperCase());
  if (!resolvedId) {
    reporter.warn(`products: external_id ${externalId} — brand "${oldBrandName}" was not found in the migrated brands table, brand defaulted to ${UNSPECIFIED_BRAND}`);
    return { brand: UNSPECIFIED_BRAND, brandId: null };
  }

  return { brand: oldBrandName, brandId: resolvedId };
}

async function migrateProducts(connection, reporter, oldBrandIdToName) {
  const filePath = path.join(STAG_DB_DIR, 'products.sql');
  const statements = parseDumpFile(filePath).filter((s) => s.table === 'products');

  const [existingRows] = await connection.execute('SELECT external_id FROM products WHERE external_id IS NOT NULL');
  const existingExternalIds = new Set(existingRows.map((r) => r.external_id));

  const [brandRows] = await connection.execute('SELECT id, name FROM brands');
  const brandNameToId = new Map(brandRows.map((b) => [b.name.trim().toUpperCase(), b.id]));

  for (const { record } of statements) {
    const externalId = String(record.id);

    if (existingExternalIds.has(externalId)) {
      reporter.skipped('products', { external_id: externalId, model: record.name }, 'external_id already exists');
      continue;
    }
    if (EXCLUDED_CATEGORY_IDS.has(record.product_category_id)) {
      reporter.skipped('products', { external_id: externalId, model: record.name, product_category_id: record.product_category_id }, 'category excluded (engine oil/antifreeze — not gas-conversion equipment)');
      continue;
    }

    const category = CATEGORY_MAP[record.product_category_id];
    if (!category) {
      reporter.skipped('products', { external_id: externalId, model: record.name, product_category_id: record.product_category_id }, 'product_category_id not in CATEGORY_MAP — unexpected, a new id not seen during analysis');
      continue;
    }

    const { brand, brandId } = resolveBrand(record, oldBrandIdToName, brandNameToId, reporter, externalId);
    const fuelType = resolveFuelType(record.name);

    const { ok, error } = await withTransaction(connection, () => connection.execute(
      `INSERT INTO products (external_id, category, brand, brand_id, model, fuel_type, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, TRUE, ?, ?)`,
      [externalId, category, brand, brandId, record.name, fuelType, record.created_at, record.updated_at]
    ));

    if (ok) {
      existingExternalIds.add(externalId);
      reporter.imported('products', { external_id: externalId, category, brand, model: record.name });
    } else {
      reporter.failed('products', { external_id: externalId, model: record.name }, error.message);
    }
  }
}

module.exports = { migrateProducts };
