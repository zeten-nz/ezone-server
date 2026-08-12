const { pool } = require('../config/database');
const easyGasCatalogSyncService = require('../services/easyGasCatalogSyncService');

/**
 * POST /api/catalog-sync/run — the ONE job the admin "Sync EasyGas Catalog"
 * entry point triggers, synchronously syncing brands/products/cars and
 * returning the outcome in the same response so the caller doesn't need to
 * separately poll for status. Same runFullSync the periodic sweep
 * (services/easyGasCatalogSyncSweep.js) uses — see that function's doc
 * comment in services/easyGasCatalogSyncService.js for the full contract.
 * Returns 409 if a sync (button-triggered or the periodic sweep) is already
 * running — runFullSync's own lock detects this; nothing here re-implements
 * the check, this just translates `conflict: true` into the HTTP status.
 */
const runCatalogSync = async (req, res, next) => {
  try {
    const result = await easyGasCatalogSyncService.runFullSync(pool);
    if (result.conflict) {
      return res.status(409).json({
        success: false,
        message: 'A catalog sync is already running.',
        errorCode: 'SYNC_ALREADY_RUNNING',
        timestamp: new Date().toISOString(),
      });
    }
    res.json({
      status: result.status,
      message: result.message,
      details: result.details,
      durationMs: result.durationMs,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/catalog-sync/status — the last recorded sync outcome (from
 * sync_state), without triggering a new sync. Powers the admin catalog
 * pages' Last Sync Time/Status/Message display on initial page load.
 */
const getCatalogSyncStatus = async (req, res, next) => {
  try {
    const summary = await easyGasCatalogSyncService.getSyncSummary(pool);
    res.json(summary);
  } catch (error) {
    next(error);
  }
};

module.exports = { runCatalogSync, getCatalogSyncStatus };
