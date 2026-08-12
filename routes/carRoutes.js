const express = require('express');
const { body } = require('express-validator');
const {
  getAllCars,
  searchCars,
  createCar,
  updateCar,
  activateCar,
  deactivateCar,
  deleteCar,
} = require('../controllers/carController');
const { verifyToken, authorizeRole } = require('../middleware/auth');
const { catalogReadOnlyGuard } = require('../middleware/catalogReadOnlyGuard');

const router = express.Router();

router.use(verifyToken);

// Any authenticated role — installers search the vehicle catalog mid-form-fill.
router.get('/search', searchCars);

router.use(authorizeRole('ADMIN'));

router.get('/', getAllCars);

// EasyGas is the single source of truth for this catalog (see
// services/easyGasCatalogSyncService.js) — see productRoutes.js's identical
// comment for why these stay wired to their original controllers rather
// than being removed.
router.post('/', catalogReadOnlyGuard, [
  body('brand').trim().notEmpty().withMessage('Brand is required'),
  body('model').trim().notEmpty().withMessage('Model is required'),
], createCar);

router.put('/:carId', catalogReadOnlyGuard, [
  body('brand').trim().notEmpty().withMessage('Brand is required'),
  body('model').trim().notEmpty().withMessage('Model is required'),
], updateCar);

router.patch('/:carId/activate', catalogReadOnlyGuard, activateCar);
router.patch('/:carId/deactivate', catalogReadOnlyGuard, deactivateCar);
router.delete('/:carId', catalogReadOnlyGuard, deleteCar);

module.exports = router;
