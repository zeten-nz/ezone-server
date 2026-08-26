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
 * ENDPOINTS (current contract): the signed GET endpoints under
 * EASYGAS_WARRANTY_API_BASE_URL — {base}/brands, {base}/products,
 * {base}/cars (see easyGasCatalogClient.js). These SUPERSEDE the retired
 * /public/api/{products,product-brands,cars} paths this sync used before.
 *
 * Field mapping (product_category_id, product_brand_id, station_type, name,
 * id on products; id/brand_id/brand_name/name on cars; id/name/full_name/
 * country/logo on brands) was live-confirmed against the OLD public
 * endpoints, which served the same underlying EasyGas entities (the
 * stag-db dumps this project's one-time migration imported corroborate the
 * same column set). The NEW endpoints' exact response envelopes have not
 * yet been captured in this repository, so extraction below is deliberately
 * TOLERANT (extractRows accepts both a bare JSON array and a
 * `{data: [...]}` wrapper, paginated via `meta.last_page` when present) and
 * every field mapping stays FAIL-CLOSED: a row that doesn't carry the
 * expected fields is skipped and counted, never guessed at, and sync never
 * deletes or deactivates anything — so a shape mismatch can only ever
 * under-import (visible in the skip counts / FAILED status), never corrupt
 * local data. Note /public/api/products did NOT pre-filter server-side to
 * warranty-relevant equipment — filtering to the 4 warranty categories is
 * entirely CLIENT-SIDE via config/externalCategoryMap.js's whitelist
 * (mapExternalCategory returning null is what does the real filtering — see
 * upsertProduct below); the same applies to the new endpoint until proven
 * otherwise.
 *
 * ARCHITECTURE DECISION (final, per the catalog-sync-button update): EasyGas
 * is the single source of truth for brands/products/cars, but the app never
 * proxies to it at read time — everything the admin UI shows comes from the
 * local tables these upserts maintain. Synchronization (this file) is the
 * ONLY way local catalog data ever changes; admins can view/search/paginate
 * but can no longer create/edit/delete/activate/deactivate rows by hand (see
 * routes/productRoutes.js, brandRoutes.js, carRoutes.js — those routes were
 * removed). `runFullSync` below is the ONE job the admin "Sync EasyGas
 * Catalog" button triggers (routes/catalogSyncRoutes.js), and is also what
 * the periodic sweep (easyGasCatalogSyncSweep.js) calls — both paths share
 * identical brands→products→cars sequencing and both record the same Last
 * Sync Time/Status/Message (sync_state, sync_key='catalog').
 *
 * Per that same decision, deletion-detection (auto-deactivating local rows
 * that vanished from a full pull) has been REMOVED from syncProducts and
 * syncCars below — EasyGas currently exposes no explicit deletion signal, so
 * a product/car simply missing from one pull is no longer treated as
 * evidence it was deleted (a paused category, a mid-pagination hiccup, or a
 * temporary EasyGas-side filter change would previously have caused a false
 * deactivation). Sync now only ever inserts new rows and updates existing
 * ones by external_id — it never flips is_active to FALSE. If EasyGas ever
 * adds a real deletion mechanism (e.g. a `deleted` flag or a tombstone
 * endpoint), that should drive is_active going forward, not absence.
 *
 * LOCKING (added for the "never run twice simultaneously" requirement):
 * runFullSync claims an atomic DB-level lock (acquireSyncLock, sync_state.
 * sync_key='catalog') before doing anything else. A plain in-memory flag
 * would NOT be enough — the manual "Sync" button is a normal HTTP request
 * that can land on any PM2 cluster worker, while the periodic sweep only
 * ever runs on worker 0 (see easyGasCatalogSyncSweep.js), so two different
 * worker processes need to agree on "is a sync already running" through
 * something both can see: the database. If the lock can't be claimed,
 * runFullSync returns immediately with `conflict: true` and touches nothing
 * else — the actually-running sync's own eventual result is never
 * overwritten. A stale RUNNING row (process crashed mid-sync) self-heals
 * after SYNC_LOCK_STALE_MINUTES so one crash can't wedge sync forever.
 *
 * STATUS DETAILS: on SUCCESS, `details` is a per-entity breakdown —
 * `{ products: {inserted, updated, skipped, failed}, brands: {...}, cars: {...} }`
 * — inserted/updated are read directly off MySQL's own affectedRows for the
 * `INSERT ... ON DUPLICATE KEY UPDATE` (1 = fresh insert, 2 = existing row's
 * values changed, 0 = matched but identical — folded into "updated" here,
 * since it was still successfully processed, just a no-op write). "failed"
 * counts a per-row exception during that one row's upsert (a genuinely
 * malformed record) without aborting the rest of that entity's sync — a
 * small addition to upsertProduct/upsertBrand/upsertCar's callers, kept
 * deliberately local to each loop iteration rather than restructuring them.
 */
const easyGasCatalogClient = require('./easyGasCatalogClient');
const { mapExternalCategory } = require('../config/externalCategoryMap');

const PAGE_SIZE = 100; // the old public API 422'd above 100; harmless if the new endpoint ignores it

/**
 * Extracts the row array out of an EasyGas list response, tolerantly:
 * accepts a Laravel-style `{ data: [...] }` wrapper (what the old public
 * endpoints returned) OR a bare top-level JSON array. Anything else yields
 * an empty array — fail-closed, the per-row upserts then simply have
 * nothing to write and the counts make that visible.
 */
const extractRows = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
};

/**
 * Walks every page of a signed EasyGas list endpoint. Pagination fields are
 * read tolerantly: `meta.last_page` (the Laravel wrapper the old public
 * endpoints used) or a top-level `last_page`; when neither exists (an
 * unpaginated response — a bare array or a plain `{data: [...]}`), the walk
 * correctly stops after page 1, which then already contained everything.
 * Stops as soon as a page fails (network error or non-2xx) instead of
 * skipping ahead, so a mid-walk failure just means "try again next sweep
 * cycle," never a silent gap. Surfaces a short machine-readable `reason` on
 * failure ('network' or `http_<status>`) so runFullSync can report a real,
 * specific Last Sync Message instead of a bare "failed".
 */
const walkPaginatedCatalog = async (fetchPage, onPage) => {
  let page = 1;
  for (;;) {
    const result = await fetchPage(page);
    if (!result.ok) return { ok: false, reason: result.networkError ? 'network' : `http_${result.status}` };
    await onPage(extractRows(result.data));
    const lastPage = result.data?.meta?.last_page || result.data?.last_page || 1;
    if (page >= lastPage) return { ok: true };
    page += 1;
  }
};

// `updated_since` is deliberately never sent below — every cycle does a full
// walk instead, simply because EasyGas's catalog contract documents no such
// filter param on these endpoints (not invented here). The sync_state
// checkpoint below is recorded purely for "when did this last run
// successfully" visibility — nothing reads it back to filter a request, and
// (per the architecture decision — see the file header) it's no longer used
// to detect vanished rows either, since sync never auto-deactivates.
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
 * come directly from EasyGas (field set confirmed on the old public
 * endpoint and corroborated by the stag-db product_brands dump; a row
 * missing id/name is skipped, never guessed at — see the file header).
 * Brands must come from EasyGas, never be locally invented (see
 * project architecture memory) — this upsert is the entire source of truth
 * for the `brands` table. Returns which of insert/update/unchanged happened,
 * read off MySQL's own affectedRows for the ON DUPLICATE KEY UPDATE (see the
 * STATUS DETAILS note in this file's header) — no extra query needed.
 */
const upsertBrand = async (pool, brand) => {
  if (!brand?.id || !brand?.name) return { outcome: 'skipped', reason: 'invalid_shape' };
  const [result] = await pool.execute(
    `INSERT INTO brands (external_id, name, full_name, country, logo_url, synced_at)
     VALUES (?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE name = VALUES(name), full_name = VALUES(full_name),
       country = VALUES(country), logo_url = VALUES(logo_url), synced_at = VALUES(synced_at)`,
    [String(brand.id), brand.name, brand.full_name || null, brand.country || null, brand.logo || null]
  );
  return { outcome: result.affectedRows === 1 ? 'inserted' : result.affectedRows === 2 ? 'updated' : 'unchanged' };
};

/**
 * Brands via the signed GET {base}/brands endpoint. The old public
 * /product-brands endpoint returned all ~26 brands in one unpaginated
 * `{data: [...]}` response; the new endpoint is routed through the same
 * tolerant walkPaginatedCatalog as products/cars so an unpaginated response
 * still works (stops after page 1) and a paginated one is walked fully.
 * Each brand's upsert is individually try/caught so one malformed row can't
 * abort the rest of the batch — counts toward `failed` instead.
 */
const syncBrands = async (pool) => {
  const counts = { inserted: 0, updated: 0, skipped: 0, failed: 0, total: 0 };
  const walk = await walkPaginatedCatalog(
    (page) => easyGasCatalogClient.getBrands({ page, per_page: PAGE_SIZE }),
    async (rows) => {
      counts.total += rows.length;
      for (const brand of rows) {
        try {
          const { outcome } = await upsertBrand(pool, brand);
          if (outcome === 'inserted') counts.inserted += 1;
          else if (outcome === 'updated' || outcome === 'unchanged') counts.updated += 1;
          else counts.skipped += 1;
        } catch (error) {
          counts.failed += 1;
          console.warn(`[EasyGas Catalog Sync] Failed to upsert brand id=${brand?.id}: ${error.message}`);
        }
      }
    }
  );
  if (!walk.ok) return { ok: false, reason: walk.reason };
  return { ok: true, ...counts };
};

const resolveBrandById = async (pool, externalBrandId) => {
  if (!externalBrandId) return null;
  const [rows] = await pool.execute('SELECT id, name FROM brands WHERE external_id = ?', [String(externalBrandId)]);
  return rows[0] || null;
};

// The real category field is product_category_id (+ product_category_name
// for the human label) — confirmed on the old public endpoint and
// corroborated by the stag-db products dump. The endpoint returns EasyGas's
// ENTIRE product line, and config/externalCategoryMap.js's whitelist is the
// real, routine filtering mechanism (the majority of products hit this
// skip path — not a rare edge case). Tracks which unmapped ids have
// already been logged so each of those categories logs once for diagnosis,
// not once per product per sync cycle.
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
    return { outcome: 'skipped', reason: 'category', categoryId: product.product_category_id, categoryName: product.product_category_name };
  }
  const brand = await resolveBrandById(pool, product.product_brand_id);
  if (!brand) {
    console.warn(
      `[EasyGas Catalog Sync] Product ${product.id} references brand_id ${product.product_brand_id} ` +
      `(brand_name="${product.brand_name}") with no matching local brand — skipped, will retry once brands catch up`
    );
    return { outcome: 'skipped', reason: 'brand' };
  }
  const model = deriveModel(product.name, brand.name);
  const fuelType = mapStationTypeToFuelType(product.station_type);
  const [result] = await pool.execute(
    `INSERT INTO products (external_id, category, brand_id, brand, model, fuel_type, synced_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), TRUE)
     ON DUPLICATE KEY UPDATE category = VALUES(category), brand_id = VALUES(brand_id), brand = VALUES(brand),
       model = VALUES(model), fuel_type = VALUES(fuel_type), synced_at = VALUES(synced_at), is_active = TRUE`,
    [String(product.id), category, brand.id, brand.name, model, fuelType]
  );
  return { outcome: result.affectedRows === 1 ? 'inserted' : result.affectedRows === 2 ? 'updated' : 'unchanged' };
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
  const counts = { inserted: 0, updated: 0, skipped: 0, failed: 0 };
  const unmappedCategories = new Map();
  const walk = await walkPaginatedCatalog(
    (page) => easyGasCatalogClient.getProducts({ page, per_page: PAGE_SIZE }),
    async (rows) => {
      for (const product of rows) {
        try {
          const result = await upsertProduct(pool, product);
          if (result.outcome === 'inserted') {
            counts.inserted += 1;
          } else if (result.outcome === 'updated' || result.outcome === 'unchanged') {
            counts.updated += 1;
          } else if (result.outcome === 'skipped') {
            counts.skipped += 1;
            if (result.reason === 'category') {
              const entry = unmappedCategories.get(result.categoryId) || { name: result.categoryName, count: 0 };
              entry.count += 1;
              unmappedCategories.set(result.categoryId, entry);
            }
          }
        } catch (error) {
          counts.failed += 1;
          console.warn(`[EasyGas Catalog Sync] Failed to upsert product id=${product?.id}: ${error.message}`);
        }
      }
    }
  );
  if (!walk.ok) return { ok: false, reason: walk.reason };

  // No deletion-detection step here by design — see the ARCHITECTURE
  // DECISION note in this file's header. A product missing from a pull is no
  // longer treated as evidence it was deleted; sync only ever inserts/updates.

  await setSyncCheckpoint(pool, 'products', startedAt);
  return {
    ok: true,
    ...counts,
    unmappedCategories: [...unmappedCategories.entries()].map(([id, v]) => ({ id, name: v.name, count: v.count })),
  };
};

/**
 * cars is its own upsert shape, not shared with upsertProduct — flat
 * brand/model strings (no brand_id FK, no category). Fields confirmed on
 * the old public endpoint (and corroborated by the stag-db cars dump): id,
 * brand_id (EasyGas's own, not resolved against our brands table here),
 * brand_name, name — there is no separate `model` field, `name` carries
 * it. A row missing id/brand_name/name is skipped, never guessed at (see
 * the file header). `is_active` reactivates on re-upsert
 * (mirrors upsertProduct) — harmless now that sync never deactivates a row
 * itself (see the ARCHITECTURE DECISION note in this file's header), but
 * kept as a safe default in case is_active was ever set FALSE some other way.
 */
const upsertCar = async (pool, car) => {
  if (!car?.id || !car?.brand_name || !car?.name) return { outcome: 'skipped', reason: 'invalid_shape' };
  const [result] = await pool.execute(
    `INSERT INTO cars (external_id, brand, model, synced_at, is_active)
     VALUES (?, ?, ?, NOW(), TRUE)
     ON DUPLICATE KEY UPDATE brand = VALUES(brand), model = VALUES(model), synced_at = VALUES(synced_at), is_active = TRUE`,
    [String(car.id), car.brand_name, car.name]
  );
  return { outcome: result.affectedRows === 1 ? 'inserted' : result.affectedRows === 2 ? 'updated' : 'unchanged' };
};

const syncCars = async (pool) => {
  await getSyncCheckpoint(pool, 'cars'); // recorded for visibility only, see note above
  const [[{ startedAt }]] = await pool.execute('SELECT NOW() AS startedAt'); // see syncProducts for why not new Date()
  const counts = { inserted: 0, updated: 0, skipped: 0, failed: 0 };
  // The old public /cars endpoint ignored `page`/`per_page` and returned all
  // cars in one unpaginated `{data: [...]}` response; walkPaginatedCatalog's
  // last_page fallback makes that shape (and a paginated one) both work
  // against the new signed {base}/cars endpoint — see its doc comment.
  // `.flat()` below is a no-op on a response that's already flat
  // (Array.prototype.flat only descends into elements that are themselves
  // arrays) — kept as cheap insurance against a nested shape.
  const walk = await walkPaginatedCatalog(
    (page) => easyGasCatalogClient.getCars({ page, per_page: PAGE_SIZE }),
    async (rows) => {
      for (const car of rows.flat()) {
        try {
          const { outcome } = await upsertCar(pool, car);
          if (outcome === 'inserted') counts.inserted += 1;
          else if (outcome === 'updated' || outcome === 'unchanged') counts.updated += 1;
          else counts.skipped += 1;
        } catch (error) {
          counts.failed += 1;
          console.warn(`[EasyGas Catalog Sync] Failed to upsert car id=${car?.id}: ${error.message}`);
        }
      }
    }
  );
  if (!walk.ok) return { ok: false, reason: walk.reason };

  // No deletion-detection step here either — same reasoning as syncProducts above.

  await setSyncCheckpoint(pool, 'cars', startedAt);
  return { ok: true, ...counts };
};

/**
 * Persists the outcome of one runFullSync call so the admin UI's Last Sync
 * Time/Status/Message survives a page reload without re-running the sync —
 * reuses sync_state (see config/database.js) with a dedicated sync_key
 * distinct from the per-entity 'products'/'cars' checkpoint rows above.
 * `details` is only ever populated on SUCCESS; NULL on FAILED (no partial
 * counts are reported — see runFullSync). Also doubles as the lock release:
 * writing a real last_status (SUCCESS/FAILED) here overwrites whatever
 * acquireSyncLock set it to (RUNNING).
 */
const recordSyncSummary = async (pool, { status, message, details, durationMs }) => {
  await pool.execute(
    `INSERT INTO sync_state (sync_key, last_synced_at, last_status, last_message, last_details, last_duration_ms)
     VALUES ('catalog', NOW(), ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE last_synced_at = VALUES(last_synced_at), last_status = VALUES(last_status),
       last_message = VALUES(last_message), last_details = VALUES(last_details), last_duration_ms = VALUES(last_duration_ms)`,
    [status, message, details ? JSON.stringify(details) : null, durationMs ?? null]
  );
};

/** Reads back the last runFullSync outcome — used by GET /api/catalog-sync/status
 * so the admin UI can show Never Synced/Running/Success/Failed, Last Sync
 * Time, Last Duration, and the per-entity breakdown on page load without
 * triggering a new sync. Returns nulls (never throws) if no sync has ever run. */
const getSyncSummary = async (pool) => {
  const [rows] = await pool.execute(
    'SELECT last_synced_at, last_status, last_message, last_details, last_duration_ms FROM sync_state WHERE sync_key = ?',
    ['catalog']
  );
  const row = rows[0];
  return {
    lastSyncedAt: row?.last_synced_at || null,
    status: row?.last_status || null,
    message: row?.last_message || null,
    details: row?.last_details || null, // mysql2 auto-parses the JSON column
    durationMs: row?.last_duration_ms ?? null,
  };
};

// A real full sync takes seconds; this is purely a crash-recovery safety
// net (see acquireSyncLock) — if the process dies mid-sync, the lock
// self-heals after this many minutes instead of being stuck forever.
const SYNC_LOCK_STALE_MINUTES = 15;

/**
 * Atomically claims the 'catalog' sync_state row so runFullSync can never
 * execute twice concurrently (see the LOCKING note in this file's header).
 * Single UPDATE...WHERE is the primary path — InnoDB's row lock makes two
 * near-simultaneous claims serialize, so only one can match the WHERE
 * clause and flip the row to RUNNING; the loser sees affectedRows === 0.
 * The INSERT fallback only exists for the very first sync ever (no row to
 * UPDATE yet); a duplicate-key error there just means another request won
 * that exact first-run race.
 */
const acquireSyncLock = async (pool) => {
  const [updateResult] = await pool.execute(
    `UPDATE sync_state SET last_status = 'RUNNING', sync_lock_acquired_at = NOW()
     WHERE sync_key = 'catalog'
       AND (last_status IS NULL OR last_status != 'RUNNING' OR sync_lock_acquired_at < NOW() - INTERVAL ? MINUTE)`,
    [SYNC_LOCK_STALE_MINUTES]
  );
  if (updateResult.affectedRows > 0) return true;

  try {
    await pool.execute(
      `INSERT INTO sync_state (sync_key, last_status, sync_lock_acquired_at) VALUES ('catalog', 'RUNNING', NOW())`
    );
    return true;
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return false;
    throw error;
  }
};

/**
 * The ONE synchronization job — everything the admin "Sync EasyGas Catalog"
 * entry point (routes/catalogSyncRoutes.js) and the periodic sweep
 * (easyGasCatalogSyncSweep.js) both run, so Last Sync Time/Status/Message
 * reflects whichever triggered it most recently. Brands always run first —
 * products.brand_id's FK needs the referenced brand to already exist locally
 * before a product upsert can resolve it (see upsertProduct/resolveBrandById).
 * If brands fails, products/cars are skipped entirely for this run (same
 * short-circuit the sweep used before this refactor) rather than upserting
 * against a stale/incomplete brand list. If brands succeeds but products
 * and/or cars fail, the run is still reported FAILED overall — no partial
 * `details` counts are recorded, since "partially synced" isn't one of the
 * three states (SUCCESS/FAILED/RUNNING) sync_state.last_status models; the
 * per-entity skip/import counts are still logged to the console either way.
 *
 * Returns `{ conflict: true, status: 'RUNNING', ... }` immediately, without
 * touching sync_state at all, if another run is already in progress — see
 * acquireSyncLock. The `try/catch` around the actual sync work exists solely
 * so an unexpected exception (not a modeled EasyGas network/HTTP failure —
 * those already return {ok:false} from syncBrands/syncProducts/syncCars)
 * still releases the lock via recordSyncSummary instead of leaving it
 * wedged on RUNNING until the stale-lock timeout.
 */
const runFullSync = async (pool) => {
  const locked = await acquireSyncLock(pool);
  if (!locked) {
    return { ok: false, conflict: true, status: 'RUNNING', message: 'already_running', details: null };
  }

  const startedAtMs = Date.now();
  try {
    const brandsResult = await syncBrands(pool);
    if (!brandsResult.ok) {
      const summary = { status: 'FAILED', message: `brands_failed:${brandsResult.reason}`, details: null, durationMs: Date.now() - startedAtMs };
      await recordSyncSummary(pool, summary);
      return { ok: false, ...summary, brandsResult, productsResult: null, carsResult: null };
    }

    const productsResult = await syncProducts(pool);
    const carsResult = await syncCars(pool);

    const failures = [];
    if (!productsResult.ok) failures.push(`products_failed:${productsResult.reason || 'unknown'}`);
    if (!carsResult.ok) failures.push(`cars_failed:${carsResult.reason || 'unknown'}`);

    const durationMs = Date.now() - startedAtMs;
    const summary = failures.length === 0
      ? {
          status: 'SUCCESS',
          message: 'success',
          durationMs,
          details: {
            products: { inserted: productsResult.inserted, updated: productsResult.updated, skipped: productsResult.skipped, failed: productsResult.failed },
            brands: { inserted: brandsResult.inserted, updated: brandsResult.updated, skipped: brandsResult.skipped, failed: brandsResult.failed },
            cars: { inserted: carsResult.inserted, updated: carsResult.updated, skipped: carsResult.skipped, failed: carsResult.failed },
          },
        }
      : { status: 'FAILED', message: failures.join(';'), details: null, durationMs };

    await recordSyncSummary(pool, summary);
    return { ok: failures.length === 0, ...summary, brandsResult, productsResult, carsResult };
  } catch (error) {
    const summary = { status: 'FAILED', message: `unexpected:${error.message}`.slice(0, 500), details: null, durationMs: Date.now() - startedAtMs };
    await recordSyncSummary(pool, summary);
    return { ok: false, ...summary };
  }
};

module.exports = { syncBrands, syncProducts, syncCars, runFullSync, getSyncSummary };
