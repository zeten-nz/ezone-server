const express = require('express');
const { body } = require('express-validator');
const {
  getAllBrands,
  getActiveBrands,
  createBrand,
  updateBrand,
  activateBrand,
  deactivateBrand,
  deleteBrand,
} = require('../controllers/brandController');
const { verifyToken, authorizeRole } = require('../middleware/auth');
const { catalogReadOnlyGuard } = require('../middleware/catalogReadOnlyGuard');

const router = express.Router();

router.use(verifyToken);

// Any authenticated role — installers populate the Product form's Brand
// select mid-form-fill, not just admins. Registered before the ADMIN gate
// below, same convention as productRoutes.js's /search and /brands.
router.get('/active', getActiveBrands);

router.use(authorizeRole('ADMIN'));

router.get('/', getAllBrands);

// EasyGas is the single source of truth for this catalog (see
// services/easyGasCatalogSyncService.js) — see productRoutes.js's identical
// comment for why these stay wired to their original controllers rather
// than being removed.
router.post('/', catalogReadOnlyGuard, [
  body('name').trim().notEmpty().withMessage('Brand name is required'),
  body('full_name').optional({ checkFalsy: true }).trim().isLength({ max: 255 }).withMessage('Full name must be 255 characters or fewer'),
  body('country').optional({ checkFalsy: true }).trim().isLength({ max: 100 }).withMessage('Country must be 100 characters or fewer'),
  body('logo_url').optional({ checkFalsy: true }).trim().isLength({ max: 500 }).withMessage('Logo URL must be 500 characters or fewer'),
], createBrand);

router.put('/:brandId', catalogReadOnlyGuard, [
  body('name').trim().notEmpty().withMessage('Brand name is required'),
  body('full_name').optional({ checkFalsy: true }).trim().isLength({ max: 255 }).withMessage('Full name must be 255 characters or fewer'),
  body('country').optional({ checkFalsy: true }).trim().isLength({ max: 100 }).withMessage('Country must be 100 characters or fewer'),
  body('logo_url').optional({ checkFalsy: true }).trim().isLength({ max: 500 }).withMessage('Logo URL must be 500 characters or fewer'),
], updateBrand);

router.patch('/:brandId/activate', catalogReadOnlyGuard, activateBrand);
router.patch('/:brandId/deactivate', catalogReadOnlyGuard, deactivateBrand);
router.delete('/:brandId', catalogReadOnlyGuard, deleteBrand);

module.exports = router;
