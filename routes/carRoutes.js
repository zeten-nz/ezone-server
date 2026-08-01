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

const router = express.Router();

router.use(verifyToken);

// Any authenticated role — installers search the vehicle catalog mid-form-fill.
router.get('/search', searchCars);

router.use(authorizeRole('ADMIN'));

router.get('/', getAllCars);

router.post('/', [
  body('brand').trim().notEmpty().withMessage('Brand is required'),
  body('model').trim().notEmpty().withMessage('Model is required'),
], createCar);

router.put('/:carId', [
  body('brand').trim().notEmpty().withMessage('Brand is required'),
  body('model').trim().notEmpty().withMessage('Model is required'),
], updateCar);

router.patch('/:carId/activate', activateCar);
router.patch('/:carId/deactivate', deactivateCar);
router.delete('/:carId', deleteCar);

module.exports = router;
