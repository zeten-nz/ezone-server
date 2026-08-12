/**
 * Blocks admin mutation of the EasyGas-synced catalog (products/brands/cars)
 * WITHOUT removing the routes/controllers/repositories it guards — those
 * stay fully wired and functional underneath this middleware. EasyGas is
 * the single source of truth (see services/easyGasCatalogSyncService.js);
 * sync is the only writer. If that architecture ever changes, re-enabling
 * manual catalog CRUD is a one-line removal of this middleware from the
 * affected routes — not a rewrite.
 */
const catalogReadOnlyGuard = (req, res, next) => {
  res.status(403).json({
    success: false,
    message: 'Catalog is managed by EasyGas synchronization.',
    errorCode: 'CATALOG_READ_ONLY',
    timestamp: new Date().toISOString(),
  });
};

module.exports = { catalogReadOnlyGuard };
