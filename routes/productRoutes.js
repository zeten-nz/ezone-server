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

router.post('/', [
  body('category').isIn(PRODUCT_CATEGORIES).withMessage('Invalid category'),
  body('brand').trim().notEmpty().withMessage('Brand is required'),
], createProduct);

router.put('/:productId', [
  body('category').isIn(PRODUCT_CATEGORIES).withMessage('Invalid category'),
  body('brand').trim().notEmpty().withMessage('Brand is required'),
], updateProduct);

router.patch('/:productId/activate', activateProduct);
router.patch('/:productId/deactivate', deactivateProduct);
router.delete('/:productId', deleteProduct);

module.exports = router;
