const express = require('express');
const { body } = require('express-validator');
const {
  getAllProducts,
  searchProducts,
  getBrands,
  createProduct,
  updateProduct,
  activateProduct,
  deactivateProduct,
  deleteProduct,
} = require('../controllers/productController');
const { verifyToken, authorizeRole } = require('../middleware/auth');
const { catalogReadOnlyGuard } = require('../middleware/catalogReadOnlyGuard');

const router = express.Router();

const PRODUCT_CATEGORIES = [
  'REDUCER', 'CYLINDER', 'ECU', 'INJECTOR_RAIL', 'FILLING_VALVE',
  'MULTIVALVE', 'PRESSURE_SENSOR', 'FILTER', 'OTHER', 'CONTROLLER',
];

router.use(verifyToken);

// Any authenticated role — installers search the catalog mid-form-fill, not
// just admins. Registered before the ADMIN gate below and before any
// /:productId-shaped route so it can never be shadowed by one.
router.get('/search', searchProducts);
router.get('/brands', getBrands);

router.use(authorizeRole('ADMIN'));

router.get('/', getAllProducts);

// EasyGas is the single source of truth for this catalog (see
// services/easyGasCatalogSyncService.js) — these routes stay wired to their
// original controllers/validators/repositories (nothing below was removed),
// but catalogReadOnlyGuard short-circuits every one of them with a 403
// before createProduct/updateProduct/etc. ever run. Removing the guard is
// the entire re-enable path if this decision changes.
router.post('/', catalogReadOnlyGuard, [
  body('category').isIn(PRODUCT_CATEGORIES).withMessage('Invalid category'),
  body('brand_id').isInt().withMessage('A brand must be selected'),
  body('fuel_type').optional({ checkFalsy: true }).isIn(['LPG', 'CNG']).withMessage('Invalid fuel type'),
], createProduct);

router.put('/:productId', catalogReadOnlyGuard, [
  body('category').isIn(PRODUCT_CATEGORIES).withMessage('Invalid category'),
  body('brand_id').isInt().withMessage('A brand must be selected'),
  body('fuel_type').optional({ checkFalsy: true }).isIn(['LPG', 'CNG']).withMessage('Invalid fuel type'),
], updateProduct);

router.patch('/:productId/activate', catalogReadOnlyGuard, activateProduct);
router.patch('/:productId/deactivate', catalogReadOnlyGuard, deactivateProduct);
router.delete('/:productId', catalogReadOnlyGuard, deleteProduct);

module.exports = router;
