/**
 * Periodic catalog sync — one of two paths that pull brands/products/cars
 * from EasyGas, the other being the admin "Sync EasyGas Catalog" entry point
 * (routes/catalogSyncRoutes.js). Both call the exact same
 * easyGasCatalogSyncService.runFullSync, so Last Sync Time/Status/Message
 * reflects whichever ran most recently, whether triggered by a click or by
 * this timer — and the two can never run concurrently, since runFullSync
 * itself claims a real DB-level lock now (see acquireSyncLock in that file).
 * If this cycle fires while the button-triggered sync (possibly on a
 * different PM2 worker) is still running, runFullSync just returns
 * `conflict: true` immediately and this cycle quietly no-ops — see below.
 * Separate, much slower cadence than the warranty-push sweep
 * (easyGasSyncSweep.js): catalogs change far less often than warranties need
 * pushing. Same crash-safety contract as the warranty sweep: every cycle is
 * wrapped so a failure never escapes as an unhandled rejection into
 * server.js's process.exit(1) handler.
 */
const easyGasCatalogSyncService = require('./easyGasCatalogSyncService');

const CATALOG_SYNC_INTERVAL_MS = parseInt(process.env.EASYGAS_CATALOG_SYNC_INTERVAL_MS, 10) || 300_000;

const runCatalogSyncCycle = async (pool) => {
  const result = await easyGasCatalogSyncService.runFullSync(pool);
  if (result.conflict) {
    // Not a failure — the admin "Sync EasyGas Catalog" button (or a
    // still-running previous cycle) already holds the lock. Just skip this
    // tick; the next interval will try again.
    console.log('[EasyGas Catalog Sync] Skipping this cycle — a sync is already running');
    return;
  }
  if (!result.ok) {
    console.warn(`[EasyGas Catalog Sync] Cycle failed: ${result.message}`);
    return;
  }
  const { brandsResult, productsResult, carsResult } = result;
  console.log(`[EasyGas Catalog Sync] Brands: ${brandsResult.inserted} inserted, ${brandsResult.updated} updated, ${brandsResult.skipped} skipped, ${brandsResult.failed} failed (of ${brandsResult.total})`);
  console.log(`[EasyGas Catalog Sync] Products: ${productsResult.inserted} inserted, ${productsResult.updated} updated, ${productsResult.skipped} skipped, ${productsResult.failed} failed`);
  console.log(`[EasyGas Catalog Sync] Cars: ${carsResult.inserted} inserted, ${carsResult.updated} updated, ${carsResult.skipped} skipped, ${carsResult.failed} failed`);
  console.log(`[EasyGas Catalog Sync] Cycle completed in ${result.durationMs}ms`);
};

// PM2 cluster mode sets NODE_APP_INSTANCE to '0', '1', '2', ... per worker,
// stable for the cluster's lifetime. Undefined outside cluster mode (local
// dev, fork mode) — always treated as "run" there, since there's only one
// process anyway. Gating to worker '0' only is what stops every cluster
// worker from independently re-pulling the entire EasyGas catalog on the
// same interval (this sweep has no per-row claim, unlike the warranty
// sweep's atomic PENDING->SYNCING claim, since a plain catalog upsert has
// no per-row race to guard against — see the file header comment above).
const NODE_APP_INSTANCE = process.env.NODE_APP_INSTANCE;
const isPrimaryWorker = NODE_APP_INSTANCE === undefined || NODE_APP_INSTANCE === '0';

const startEasyGasCatalogSyncSweep = (pool) => {
  if (!isPrimaryWorker) {
    console.log(`[EasyGas Catalog Sync] Worker ${NODE_APP_INSTANCE} skipping — only worker 0 runs the catalog sync sweep`);
    return;
  }
  setInterval(() => {
    runCatalogSyncCycle(pool).catch((error) => {
      console.error('[EasyGas Catalog Sync] Cycle failed:', error.message);
    });
  }, CATALOG_SYNC_INTERVAL_MS);
  console.log(`[EasyGas Catalog Sync] Catalog sync sweep started (every ${CATALOG_SYNC_INTERVAL_MS}ms)`);
};

module.exports = { startEasyGasCatalogSyncSweep, runCatalogSyncCycle };
