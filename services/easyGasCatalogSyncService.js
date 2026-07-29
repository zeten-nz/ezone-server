/**
 * Pulls EasyGas's brands/products/cars catalogs into our local tables so
 * installers search a mirrored catalog instead of typing free text. Every DB
 * call here uses pool.execute(...) directly rather than the repository
 * convention of an explicit passed-in connection — same deliberate, narrow
 * exception as easyGasSyncSweep.js, for the same reason (no multi-statement
 * transaction to coordinate, and this runs in a detached setInterval
 * context where manually acquiring/releasing a connection is pure risk for
 * no benefit).
 *
 * Every field mapping in this file was confirmed against real responses
 * pulled directly from EasyGas's signed catalog endpoints (same base/secret
 * as the warranty push — see easyGasCatalogClient.js), not guessed: real
 * /branches, /products (component_type, station_type, product_brand_id,
 * product_category_id, updated_at), /cars, and /brands responses.
 */
const easyGasCatalogClient = require('./easyGasCatalogClient');
const { mapExternalCategory } = require('../config/externalCategoryMap');

const PAGE_SIZE = 100; // confirmed real max — per_page > 100 gets HTTP 422 "must not be greater than 100"

/**
 * Walks every page of a Laravel-paginated EasyGas catalog endpoint.
 * Confirmed live against the signed /products and /cars endpoints: standard
 * Laravel paginate() shape, every field top-level —
 * `{current_page, data: [...], last_page, per_page, total, ...}` — no
 * `meta`/`links` wrapper. Stops as soon as a page fails (network error or
 * non-2xx) instead of skipping ahead, so a mid-walk failure just means "try
 * again next sweep cycle," never a silent gap. Deliberately NOT used for
 * brands — see syncBrands.
 */
const walkPaginatedCatalog = async (fetchPage, onPage) => {
  let page = 1;
  for (;;) {
    const result = await fetchPage(page);
    if (!result.ok) return { ok: false };
    const rows = result.data?.data || [];
    await onPage(rows);
    // Confirmed live against the signed endpoint: last_page is a top-level
    // field on the standard Laravel paginate() response (current_page, data,
    // last_page, per_page, total, ...) — there is no meta wrapper. Reading
    // result.data?.meta?.last_page (correct for the old, retired public
    // catalog API) always evaluated to undefined here, silently capping
    // every sync at page 1.
    const lastPage = result.data?.last_page || 1;
    if (page >= lastPage) return { ok: true };
    page += 1;
  }
};

// `updated_since` is deliberately never sent below — every cycle does a full
// walk instead. This isn't just an optimization tradeoff: EasyGas's catalog
// has no soft-deletes, so a deleted product can never appear in an
// updated_since-filtered response at all (no row left to carry a timestamp).
// Only a full pull lets syncProducts/syncCars detect and deactivate rows
// that vanished (see the deactivation step at the end of each). The
// sync_state checkpoint is still recorded for basic "when did this last run
// successfully" visibility, but nothing reads it back to filter a request.
const getSyncCheckpoint = async (pool, key) => {
  const [rows] = await pool.execute('SELECT last_synced_at FROM sync_state WHERE sync_key = ?', [key]);
  return rows[0]?.last_synced_at || null;
};

const setSyncCheckpoint = async (pool, key, when) => {
  await pool.execute(
    `INSERT INTO sync_state (sync_key, last_synced_at) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE last_synced_at = VALUES(last_synced_at)`,
    [key, when]
  );
};

/**
 * Mirrors a brand fully — id/name/full_name/country/logo (-> logo_url) all
 * come directly from EasyGas, per the confirmed real /product-brands
 * response. Brands must come from EasyGas, never be locally invented (see
 * project architecture memory) — this upsert is the entire source of truth
 * for the `brands` table.
 */
const upsertBrand = async (pool, brand) => {
  if (!brand?.id || !brand?.name) return false;
  await pool.execute(
    `INSERT INTO brands (external_id, name, full_name, country, logo_url, synced_at)
     VALUES (?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE name = VALUES(name), full_name = VALUES(full_name),
       country = VALUES(country), logo_url = VALUES(logo_url), synced_at = VALUES(synced_at)`,
    [String(brand.id), brand.name, brand.full_name || null, brand.country || null, brand.logo || null]
  );
  return true;
};

/**
 * Confirmed: /product-brands returns all 26 brands in one unpaginated
 * `{data: [...]}` response (no `meta`/`links` at all) — deliberately NOT
 * routed through walkPaginatedCatalog, kept as its own single-call function.
 */
const syncBrands = async (pool) => {
  const result = await easyGasCatalogClient.getProductBrands();
  if (!result.ok) return { ok: false, reason: result.networkError ? 'network' : `http_${result.status}` };
  const rows = result.data?.data || (Array.isArray(result.data) ? result.data : []);
  let imported = 0;
  let skipped = 0;
  for (const brand of rows) {
    if (await upsertBrand(pool, brand)) imported += 1;
    else skipped += 1;
  }
  return { ok: true, imported, skipped, total: rows.length };
};

const resolveBrandById = async (pool, externalBrandId) => {
  if (!externalBrandId) return null;
  const [rows] = await pool.execute('SELECT id, name FROM brands WHERE external_id = ?', [String(externalBrandId)]);
  return rows[0] || null;
};

// Confirmed real category field is product_category_id (+ product_category_name
// for the human label) — component_type never existed in any real product.
// Tracks which unmapped category ids have already been logged, so a category
// EasyGas uses that we haven't whitelisted logs once for diagnosis, not every
// sync cycle for every one of its products (the real catalog is EasyGas's
// entire product line — oils, hoses, fittings, accessories, etc. all included).
const loggedUnmappedCategories = new Set();

/**
 * name has no separate "model" field in the real payload — for STAG products
 * specifically, `name` already includes the brand as a prefix (e.g. "STAG
 * 300-6 QMAX PLUS"), and since display code renders `${brand} ${model}`,
 * storing the raw name verbatim would show "STAG STAG 300-6 QMAX PLUS".
 * Strips a leading brand-name prefix (case-insensitive) when present so the
 * stored model never duplicates the brand; falls back to the full name
 * otherwise (most brands, e.g. ADAX/TOMASETTO ACHILLE, don't prefix at all).
 */
const deriveModel = (name, brandName) => {
  if (!name) return null;
  if (brandName) {
    const prefix = brandName.trim();
    if (prefix && name.toLowerCase().startsWith(prefix.toLowerCase())) {
      const stripped = name.slice(prefix.length).trim();
      if (stripped) return stripped;
    }
  }
  return name;
};

/**
 * station_type is confirmed to carry exactly 3 real values ('metan', 'Metan',
 * 'propan', 'Metan va Propan' — case varies): CNG-only, LPG-only, or "both"
 * respectively. Mirrors products.fuel_type's existing "NULL = fuel-agnostic"
 * convention (see productRepository.search) — anything not recognized
 * (including "both") maps to NULL rather than guessing, since NULL already
 * means "matches either fuel type" everywhere this column is read.
 */
const mapStationTypeToFuelType = (stationType) => {
  if (!stationType) return null;
  const normalized = stationType.trim().toLowerCase();
  if (normalized === 'metan') return 'CNG';
  if (normalized === 'propan') return 'LPG';
  return null;
};

/**
 * Upserts one synced product, denormalizing brands.name into products.brand
 * in the same statement — productRepository.search/getDistinctBrands and
 * warrantyController's resolveEquipment-derived product_name all read the
 * free-text `brand` column today, so brand_id alone would make every
 * EasyGas-sourced product silently invisible in the Brand dropdown
 * installers actually use. Joined via product_brand_id -> brands.external_id
 * -> local brands.id, never by brand_name (brand_name is only used here as
 * diagnostic context in the skip-log message, never as the join key).
 * Fails closed (skips, logs) rather than guessing when the category has no
 * mapping or the brand hasn't synced yet.
 */
const upsertProduct = async (pool, product) => {
  const category = mapExternalCategory(product.product_category_id);
  if (!category) {
    const key = String(product.product_category_id);
    if (!loggedUnmappedCategories.has(key)) {
      loggedUnmappedCategories.add(key);
      console.warn(
        `[EasyGas Catalog Sync] Unmapped category id=${product.product_category_id} name="${product.product_category_name}" ` +
        `— skipping this and every future product in this category.`
      );
    }
    return { inserted: false, skipReason: 'category', categoryId: product.product_category_id, categoryName: product.product_category_name };
  }
  const brand = await resolveBrandById(pool, product.product_brand_id);
  if (!brand) {
    console.warn(
      `[EasyGas Catalog Sync] Product ${product.id} references brand_id ${product.product_brand_id} ` +
      `(brand_name="${product.brand_name}") with no matching local brand — skipped, will retry once brands catch up`
    );
    return { inserted: false, skipReason: 'brand' };
  }
  const model = deriveModel(product.name, brand.name);
  const fuelType = mapStationTypeToFuelType(product.station_type);
  await pool.execute(
    `INSERT INTO products (external_id, category, brand_id, brand, model, fuel_type, synced_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), TRUE)
     ON DUPLICATE KEY UPDATE category = VALUES(category), brand_id = VALUES(brand_id), brand = VALUES(brand),
       model = VALUES(model), fuel_type = VALUES(fuel_type), synced_at = VALUES(synced_at), is_active = TRUE`,
    [String(product.id), category, brand.id, brand.name, model, fuelType]
  );
  return { inserted: true };
};

const syncProducts = async (pool) => {
  await getSyncCheckpoint(pool, 'products'); // recorded for visibility only, not used to filter the request (see note above)
  // Read the cycle's start time FROM MySQL itself (never Node's own
  // new Date()) so it's compared against synced_at through the exact same
  // connection/driver timezone assumption, whatever that happens to be —
  // self-consistent regardless of whether the caller's pool forces UTC.
  // Confirmed the hard way: a pool without timezone: '+00:00' forced (an
  // ad-hoc test connection, not this app's real pool) mismatched a JS Date
  // parameter against stored TIMESTAMP values badly enough to mark every
  // just-synced row "stale" in the same cycle it was upserted.
  const [[{ startedAt }]] = await pool.execute('SELECT NOW() AS startedAt');
  let imported = 0;
  let skippedCategory = 0;
  let skippedBrand = 0;
  const unmappedCategories = new Map();
  const walk = await walkPaginatedCatalog(
    (page) => easyGasCatalogClient.getProducts({ page, per_page: PAGE_SIZE }),
    async (rows) => {
      for (const product of rows) {
        const result = await upsertProduct(pool, product);
        if (result.inserted) {
          imported += 1;
        } else if (result.skipReason === 'category') {
          skippedCategory += 1;
          const entry = unmappedCategories.get(result.categoryId) || { name: result.categoryName, count: 0 };
          entry.count += 1;
          unmappedCategories.set(result.categoryId, entry);
        } else if (result.skipReason === 'brand') {
          skippedBrand += 1;
        }
      }
    }
  );
  if (!walk.ok) return { ok: false };

  // Deletion detection: EasyGas's catalog has no soft-deletes, so a deleted
  // product simply never appears in this (or any) pull again — the only way
  // to notice is a full walk that completed successfully (guaranteed above
  // by `walk.ok`) finding a local, EasyGas-sourced row it never touched.
  // Every row actually upserted this cycle got synced_at = NOW() (>=
  // startedAt); anything older that's still marked active genuinely vanished.
  // resolveEquipment already rejects an inactive product and
  // productRepository.search already filters is_active = TRUE, so this alone
  // is enough to stop a vanished product from being used in a new warranty.
  await pool.execute(
    'UPDATE products SET is_active = FALSE WHERE external_id IS NOT NULL AND is_active = TRUE AND synced_at < ?',
    [startedAt]
  );

  await setSyncCheckpoint(pool, 'products', startedAt);
  return {
    ok: true,
    imported,
    skippedCategory,
    skippedBrand,
    unmappedCategories: [...unmappedCategories.entries()].map(([id, v]) => ({ id, name: v.name, count: v.count })),
  };
};

/**
 * cars is its own upsert shape, not shared with upsertProduct — flat
 * brand/model strings (no brand_id FK, no category). Confirmed real fields
 * on the signed endpoint: id, brand_id (EasyGas's own, not resolved against
 * our brands table here — out of scope of this fix), brand_name, name,
 * updated_at — there is no separate `model` field, `name` carries it.
 * `is_active` reactivates on re-upsert (mirrors upsertProduct) so a car that
 * was deactivated by a past sync's deletion-detection step and later
 * reappears isn't stuck inactive forever.
 */
const upsertCar = async (pool, car) => {
  if (!car?.id || !car?.brand_name || !car?.name) return false;
  await pool.execute(
    `INSERT INTO cars (external_id, brand, model, synced_at, is_active)
     VALUES (?, ?, ?, NOW(), TRUE)
     ON DUPLICATE KEY UPDATE brand = VALUES(brand), model = VALUES(model), synced_at = VALUES(synced_at), is_active = TRUE`,
    [String(car.id), car.brand_name, car.name]
  );
  return true;
};

const syncCars = async (pool) => {
  await getSyncCheckpoint(pool, 'cars'); // recorded for visibility only, see note above
  const [[{ startedAt }]] = await pool.execute('SELECT NOW() AS startedAt'); // see syncProducts for why not new Date()
  let imported = 0;
  let skipped = 0;
  const walk = await walkPaginatedCatalog(
    (page) => easyGasCatalogClient.getCars({ page, per_page: PAGE_SIZE }),
    async (rows) => {
      for (const car of rows) {
        if (await upsertCar(pool, car)) imported += 1;
        else skipped += 1;
      }
    }
  );
  if (!walk.ok) return { ok: false };

  // Deletion detection — same reasoning as syncProducts above.
  await pool.execute(
    'UPDATE cars SET is_active = FALSE WHERE external_id IS NOT NULL AND is_active = TRUE AND synced_at < ?',
    [startedAt]
  );

  await setSyncCheckpoint(pool, 'cars', startedAt);
  return { ok: true, imported, skipped };
};

module.exports = { syncBrands, syncProducts, syncCars };
