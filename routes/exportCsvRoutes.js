const express = require('express');
const {
  exportInventory,
  exportWarranty,
  exportPoints,
  exportReports,
  exportInstallerStatistics,
  exportProductStatistics,
  exportWarehouseStatistics,
} = require('../controllers/exportCsvController');
const { verifyToken, authorizeRole, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(verifyToken, authorizeRole('ADMIN'));

// Read-only data any admin can already see in-app.
router.get('/inventory.csv', exportInventory);
router.get('/warranty.csv', exportWarranty);
router.get('/reports.csv', exportReports);
router.get('/product-statistics.csv', exportProductStatistics);
router.get('/warehouse-statistics.csv', exportWarehouseStatistics);

// Super Admin only — includes points/manual-adjustment-adjacent detail,
// matching Phase 3's gating precedent for that data.
router.get('/points.csv', requireSuperAdmin, exportPoints);
router.get('/installer-statistics.csv', requireSuperAdmin, exportInstallerStatistics);

module.exports = router;
