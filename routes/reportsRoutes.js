const express = require('express');
const {
  getTopInstallers,
  getMonthlyActivity,
  getProductsInstalled,
  getBranchRanking,
  getDashboardTotals,
  getPointsLeaderboard,
  getTopWarehouses,
  getRecentImports,
  getRecentWarrantyActivity,
  getRecentInventoryActivity,
  getInstallerStatistics,
  getMyStatistics,
  getProductStatistics,
  getWarehouseStatistics,
} = require('../controllers/reportsController');
const { verifyToken, authorizeRole } = require('../middleware/auth');

const router = express.Router();

router.use(verifyToken);

// Any authenticated role — an installer views only their own statistics,
// always scoped to req.user.id server-side, mirroring GET /points/mine.
// Registered BEFORE the router-wide ADMIN gate below — appending it after
// would silently make it Admin-only (see the Phase 4 plan's independent
// review finding on this exact routing-order risk).
router.get('/my-statistics', getMyStatistics);

// Reports are gated to any ADMIN-tier account (not Super-Admin-specific —
// confirmed decision, Phase 4 plan) — matches every existing report here.
router.use(authorizeRole('ADMIN'));

router.get('/top-installers', getTopInstallers);
router.get('/monthly-activity', getMonthlyActivity);
router.get('/products-installed', getProductsInstalled);
router.get('/branch-ranking', getBranchRanking);
router.get('/dashboard-totals', getDashboardTotals);
router.get('/points-leaderboard', getPointsLeaderboard);
router.get('/top-warehouses', getTopWarehouses);
router.get('/recent-imports', getRecentImports);
router.get('/recent-warranty-activity', getRecentWarrantyActivity);
router.get('/recent-inventory-activity', getRecentInventoryActivity);
router.get('/installer/:installerId/statistics', getInstallerStatistics);
router.get('/product/:productId/statistics', getProductStatistics);
router.get('/warehouse/:branchId/statistics', getWarehouseStatistics);

module.exports = router;
