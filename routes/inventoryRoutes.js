const express = require('express');
const { body } = require('express-validator');
const {
  csvUpload,
  importInventory,
  getInventory,
  getImportBatches,
  getImportBatchDetail,
  validateBarcode,
  changeStatusManually,
  transferBranch,
  correctBarcode,
  mergeDuplicate,
} = require('../controllers/inventoryController');
const { verifyToken, authorizeRole, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

const INVENTORY_STATUSES = ['IN_STOCK', 'RESERVED', 'INSTALLED', 'RETURNED', 'DAMAGED', 'LOST'];
const reasonRule = body('reason').trim().notEmpty().withMessage('A reason is required');

router.use(verifyToken);

// Any authenticated role — installers validate a scanned/typed barcode
// mid-warranty-form-fill, not just admins. Registered before the ADMIN gate
// below, same pattern as productRoutes.js's /search.
router.get('/validate/:barcode', validateBarcode);

// Warehouse operations (import/browse/history) reuse the ADMIN role
// (confirmed decision) — no separate warehouse role exists.
router.use(authorizeRole('ADMIN'));

// Literal-string routes before /:batchId-shaped ones, matching this
// project's established routing convention (see warrantyRoutes.js).
router.get('/import-batches', getImportBatches);
router.get('/import-batches/:batchId', getImportBatchDetail);

router.post('/import', csvUpload.single('file'), importInventory);
router.get('/', getInventory);

// Phase 4 manual operations — Super Admin only (matching the precedent set
// by points configuration/manual adjustments in Phase 3: these are write
// actions with real physical/financial-adjacent consequences, not ordinary
// admin browsing). Every one requires a `reason`, per the spec.
router.patch('/:itemId/status', requireSuperAdmin, [
  reasonRule,
  body('fromStatus').isIn(INVENTORY_STATUSES).withMessage('Invalid fromStatus'),
  body('toStatus').isIn(INVENTORY_STATUSES).withMessage('Invalid toStatus'),
], changeStatusManually);

router.patch('/:itemId/branch', requireSuperAdmin, [
  reasonRule,
  body('branchId').optional({ nullable: true, checkFalsy: true }).isInt().withMessage('branchId must be an integer'),
], transferBranch);

router.patch('/:itemId/barcode', requireSuperAdmin, [
  reasonRule,
  body('newBarcode').trim().notEmpty().withMessage('A new barcode is required'),
], correctBarcode);

router.post('/:itemId/merge', requireSuperAdmin, [
  reasonRule,
  body('canonicalItemId').isInt().withMessage('canonicalItemId is required'),
], mergeDuplicate);

module.exports = router;
