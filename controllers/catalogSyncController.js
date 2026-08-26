const { pool } = require('../config/database');
const easyGasCatalogSyncService = require('../services/easyGasCatalogSyncService');
const easyGasCatalogClient = require('../services/easyGasCatalogClient');

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

/**
 * GET /api/catalog-sync/verify — signed lookup against EasyGas's GET
 * {base}/verify endpoint (ADMIN-only, backend-to-backend; the browser never
 * talks to admin.stag.uz directly). REAL CONTRACT (confirmed by a signed
 * production probe, 2026-08-26): EasyGas requires exactly one of the query
 * params `phone`, `vin`, or `serial` — a parameterless call is a guaranteed
 * 422 FIELD_REQUIRED (a validation rejection, not an auth failure), so this
 * endpoint REFUSES to forward a parameterless request at all (400
 * VERIFY_QUERY_REQUIRED) instead of making a call that can only fail. The
 * admin supplies the value explicitly in the UI — never invented or
 * auto-picked from customer data here. Exactly one param is forwarded
 * (first non-empty of phone/vin/serial); the success-response body is
 * passed through uninterpreted, and NOTHING else depends on this call —
 * warranty creation/approval and catalog sync never gate on it.
 */
const verifyEasyGasConnection = async (req, res, next) => {
  try {
    const query = {};
    for (const field of ['phone', 'vin', 'serial']) {
      const value = typeof req.query[field] === 'string' ? req.query[field].trim() : '';
      if (value) {
        query[field] = value.slice(0, 100);
        break; // EasyGas wants ONE of phone/vin/serial — forward only the first provided
      }
    }
    if (Object.keys(query).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'One of phone, vin or serial is required',
        errorCode: 'VERIFY_QUERY_REQUIRED',
        timestamp: new Date().toISOString(),
      });
    }
    const result = await easyGasCatalogClient.verify(query);
    res.json({
      ok: result.ok,
      status: result.status,
      networkError: result.networkError || false,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { runCatalogSync, getCatalogSyncStatus, verifyEasyGasConnection };
