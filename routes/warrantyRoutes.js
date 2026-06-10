const express = require('express');
const { body } = require('express-validator');
const {
  createWarrantyForm,
  getAllWarrantyForms,
  getWarrantyFormDetail,
  deleteWarrantyForm,
  searchWarrantyForms
} = require('../controllers/warrantyController');
const { verifyToken, authorizeRole } = require('../middleware/auth');

const router = express.Router();

router.post('/', verifyToken, [
  body('region').notEmpty(),
  body('city').notEmpty(),
  body('district').notEmpty(),
  body('organization_name').notEmpty(),
  body('organization_phone').notEmpty(),
  body('installer_full_name').notEmpty(),
  body('warranty_book_number').notEmpty(),
  body('installation_date').notEmpty(),
  body('vehicle_brand').notEmpty(),
  body('vehicle_model').notEmpty(),
  body('vehicle_production_year').notEmpty(),
  body('vehicle_plate_number').notEmpty(),
  body('vehicle_vin').notEmpty(),
  body('vehicle_engine_volume').notEmpty(),
  body('vehicle_engine_power').notEmpty(),
  body('vehicle_mileage').notEmpty(),
  body('owner_full_name').notEmpty(),
  body('owner_phone').notEmpty(),
  body('reducer_fuel_type').isIn(['LPG', 'CNG']),
  body('reducer_manufacturer').notEmpty(),
  body('reducer_serial_number').notEmpty(),
  body('cylinder_fuel_type').isIn(['LPG', 'CNG']),
  body('cylinder_manufacturer').notEmpty(),
  body('cylinder_serial_number').notEmpty(),
  body('stag_controller_manufacturer').notEmpty(),
  body('stag_controller_serial_number').notEmpty(),
  body('injector_rail_manufacturer').notEmpty(),
  body('injector_rail_serial_number').notEmpty()
], createWarrantyForm);

router.get('/search', verifyToken, authorizeRole('ADMIN'), searchWarrantyForms);

router.get('/', verifyToken, authorizeRole('ADMIN'), getAllWarrantyForms);

router.get('/:formId', verifyToken, authorizeRole('ADMIN'), getWarrantyFormDetail);

router.delete('/:formId', verifyToken, authorizeRole('ADMIN'), deleteWarrantyForm);

module.exports = router;
