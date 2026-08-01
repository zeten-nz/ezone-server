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

const router = express.Router();

router.use(verifyToken);

// Any authenticated role — installers populate the Product form's Brand
// select mid-form-fill, not just admins. Registered before the ADMIN gate
// below, same convention as productRoutes.js's /search and /brands.
router.get('/active', getActiveBrands);

router.use(authorizeRole('ADMIN'));

router.get('/', getAllBrands);

router.post('/', [
  body('name').trim().notEmpty().withMessage('Brand name is required'),
  body('full_name').optional({ checkFalsy: true }).trim().isLength({ max: 255 }).withMessage('Full name must be 255 characters or fewer'),
  body('country').optional({ checkFalsy: true }).trim().isLength({ max: 100 }).withMessage('Country must be 100 characters or fewer'),
  body('logo_url').optional({ checkFalsy: true }).trim().isLength({ max: 500 }).withMessage('Logo URL must be 500 characters or fewer'),
], createBrand);

router.put('/:brandId', [
  body('name').trim().notEmpty().withMessage('Brand name is required'),
  body('full_name').optional({ checkFalsy: true }).trim().isLength({ max: 255 }).withMessage('Full name must be 255 characters or fewer'),
  body('country').optional({ checkFalsy: true }).trim().isLength({ max: 100 }).withMessage('Country must be 100 characters or fewer'),
  body('logo_url').optional({ checkFalsy: true }).trim().isLength({ max: 500 }).withMessage('Logo URL must be 500 characters or fewer'),
], updateBrand);

router.patch('/:brandId/activate', activateBrand);
router.patch('/:brandId/deactivate', deactivateBrand);
router.delete('/:brandId', deleteBrand);

module.exports = router;
