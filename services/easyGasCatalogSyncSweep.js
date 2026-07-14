/**
 * Periodic catalog sync — the only path that ever pulls brands/products/cars
 * from EasyGas. Separate, much slower cadence than the warranty-push sweep
 * (easyGasSyncSweep.js): catalogs change far less often than warranties need
 * pushing, and there's no per-row race to guard here (this sweep only ever
 * reads from EasyGas and upserts locally — nothing to atomically "claim").
 * Same crash-safety contract as the warranty sweep: every cycle is wrapped
 * so a failure never escapes as an unhandled rejection into server.js's
 * process.exit(1) handler.
 */
const easyGasCatalogSyncService = require('./easyGasCatalogSyncService');

const CATALOG_SYNC_INTERVAL_MS = parseInt(process.env.EASYGAS_CATALOG_SYNC_INTERVAL_MS, 10) || 300_000;

/**
 * Brands always sync first — products.brand_id's FK needs the referenced
 * brand to already exist locally before a product upsert can resolve it
 * (see easyGasCatalogSyncService.upsertProduct). If brands fail (e.g. a
 * network hiccup), skip products/cars entirely this cycle rather than
 * upserting products against a stale/incomplete brand list.
 */
const runCatalogSyncCycle = async (pool) => {
  const brandsResult = await easyGasCatalogSyncService.syncBrands(pool);
  if (!brandsResult.ok) {
    console.warn('[EasyGas Catalog Sync] Brands sync failed, skipping this cycle:', brandsResult.reason);
    return;
  }
  console.log(`[EasyGas Catalog Sync] Brands: ${brandsResult.imported} imported, ${brandsResult.skipped} skipped (of ${brandsResult.total})`);

  const productsResult = await easyGasCatalogSyncService.syncProducts(pool);
  if (productsResult.ok) {
    console.log(`[EasyGas Catalog Sync] Products: ${productsResult.imported} imported, ${productsResult.skippedCategory} skipped (unmapped category), ${productsResult.skippedBrand} skipped (unresolved brand)`);
  } else {
    console.warn('[EasyGas Catalog Sync] Products sync failed this cycle');
  }

  const carsResult = await easyGasCatalogSyncService.syncCars(pool);
  if (carsResult.ok) {
    console.log(`[EasyGas Catalog Sync] Cars: ${carsResult.imported} imported, ${carsResult.skipped} skipped`);
  } else {
    console.warn('[EasyGas Catalog Sync] Cars sync failed this cycle');
  }
};

const startEasyGasCatalogSyncSweep = (pool) => {
  setInterval(() => {
    runCatalogSyncCycle(pool).catch((error) => {
      console.error('[EasyGas Catalog Sync] Cycle failed:', error.message);
    });
  }, CATALOG_SYNC_INTERVAL_MS);
  console.log(`[EasyGas Catalog Sync] Catalog sync sweep started (every ${CATALOG_SYNC_INTERVAL_MS}ms)`);
};

module.exports = { startEasyGasCatalogSyncSweep, runCatalogSyncCycle };
