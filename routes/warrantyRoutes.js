const express = require('express');
const { body } = require('express-validator');
const {
  createWarrantyForm,
  updateWarrantyForm,
  getAllWarrantyForms,
  getWarrantyFormDetail,
  deleteWarrantyForm,
  searchWarrantyForms,
  getMyWarrantyForms,
  retryWarrantySync,
} = require('../controllers/warrantyController');
const { verifyToken, authorizeRole } = require('../middleware/auth');

const router = express.Router();

// Shared validation rules reused by both POST (create) and PUT (update).
// installer_region/installer_district/installer_branch/installer_full_name/
// installer_phone/installer_branch_code are deliberately NOT validated here
// — the server never reads them from the request body at all (see
// warrantyService.getEmployeeSnapshot); they're derived from the submitting
// employee's own branch/profile, not client input. vehicle_plate_number is
// intentionally optional — many customers have no plate yet.
//
// vehicle_production_year/vehicle_mileage/installation_date ranges and
// warranty_book_number's now-optional status mirror EasyGas's documented
// integration limits exactly (see the EasyGas plan) — failing fast locally
// avoids a pointless round trip just to get the same rejection back from
// their sync a few seconds later.
const currentYear = new Date().getFullYear();
const warrantyValidationRules = [
  // Installers no longer type a warranty number — EasyGas generates the
  // official one, landed here by the sync sweep once it succeeds.
  body('warranty_book_number').optional({ nullable: true, checkFalsy: true }),
  // Generated client-side once per warranty (crypto.randomUUID()) and
  // reused across edits — this is the idempotency key EasyGas dedupes by,
  // never regenerated on update. See WarrantyFormFields.jsx's
  // createEmptyWarrantyForm().
  body('submission_uuid').notEmpty().isUUID().withMessage('A valid submission_uuid is required'),
  body('installation_date')
    .notEmpty()
    .isISO8601().withMessage('installation_date must be a valid date')
    .custom((value) => {
      const date = new Date(value);
      const minDate = new Date('2015-01-01');
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + 1); // tolerate same-day timezone rounding, not genuinely future
      if (date < minDate || date > maxDate) {
        throw new Error('installation_date must be between 2015-01-01 and today');
      }
      return true;
    }),
  // One fuel type for the whole installation, not one per equipment row —
  // see the equipment redesign in config/database.js's fuel_type migration.
  body('fuel_type').notEmpty().isIn(['LPG', 'CNG']),
  body('vehicle_name').notEmpty(),
  // Set only when the installer picked a match from the synced car catalog
  // autocomplete — free text (car_id absent/null) always remains valid, per
  // the plan's catalog-first-with-free-text-fallback decision.
  body('car_id').optional({ nullable: true }).isInt().withMessage('car_id must be an integer'),
  body('vehicle_production_year').isInt({ min: 1950, max: currentYear + 1 }).withMessage(`vehicle_production_year must be between 1950 and ${currentYear + 1}`),
  body('vehicle_plate_number').optional({ nullable: true, checkFalsy: true }),
  body('vehicle_vin').notEmpty(),
  body('vehicle_mileage').isInt({ min: 0, max: 4294967295 }).withMessage('vehicle_mileage must be between 0 and 4294967295'),
  body('owner_full_name').notEmpty(),
  body('owner_phone').notEmpty(),
  // Exactly the 4 fixed equipment slots (Reducer/Cylinder/Controller/
  // Injector Rail) — completeness (all 4, no duplicates) and product
  // validity are enforced in warrantyService.resolveEquipment, since a
  // shape-only check here can't confirm the product actually exists.
  body('equipment').isArray({ min: 4, max: 4 }).withMessage('All 4 equipment types are required'),
  body('equipment.*.equipment_type').isIn(['REDUCER', 'CYLINDER', 'CONTROLLER', 'INJECTOR_RAIL']),
  body('equipment.*.product_id').isInt().withMessage('A product must be selected for each equipment row'),
];

router.post('/', verifyToken, warrantyValidationRules, createWarrantyForm);

// Literal-string routes must come before /:formId to avoid Express treating them as IDs.
router.get('/search', verifyToken, authorizeRole('ADMIN'), searchWarrantyForms);
router.get('/my',     verifyToken, getMyWarrantyForms);

router.get('/',    verifyToken, authorizeRole('ADMIN'), getAllWarrantyForms);

// Controller handles role-based authorization (employee ownership + 24 h window / admin unrestricted).
router.put('/:formId',    verifyToken, warrantyValidationRules, updateWarrantyForm);
router.get('/:formId',    verifyToken, authorizeRole('ADMIN'), getWarrantyFormDetail);
router.delete('/:formId', verifyToken, authorizeRole('ADMIN'), deleteWarrantyForm);

// Manual retry for a warranty stuck in FAILED EasyGas sync status.
router.post('/:formId/retry-sync', verifyToken, authorizeRole('ADMIN'), retryWarrantySync);

module.exports = router;
