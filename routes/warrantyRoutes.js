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
  approveManualVerification,
  rejectManualVerification,
  approveWarrantyForm,
  rejectWarrantyForm,
  uploadEquipmentPhoto,
  streamEquipmentPhoto,
} = require('../controllers/warrantyController');
const { verifyToken, authorizeRole } = require('../middleware/auth');
const { handleManualVerificationPhotoUpload } = require('../config/uploads');
const { PHONE_REGEX } = require('../config/validation');

const router = express.Router();

// Shared validation rules reused by both POST (create) and PUT (update).
// installer_region/installer_district/installer_branch/installer_full_name/
// installer_phone/installer_branch_code are deliberately NOT validated here
// — the server never reads them from the request body at all (see
// warrantyService.getEmployeeSnapshot); they're derived from the submitting
// employee's own branch/profile, not client input. vehicle_plate_number is
// intentionally optional — many customers have no plate yet.
//
const currentYear = new Date().getFullYear();
const warrantyValidationRules = [
  // Generated client-side once per warranty (crypto.randomUUID()) and
  // reused across edits — this is this warranty's create-idempotency key
  // (protects against a client retrying a POST it doesn't know already
  // succeeded), never regenerated on update. See WarrantyFormFields.jsx's
  // createEmptyWarrantyForm(). warranty_book_number is deliberately not
  // accepted from the client at all — it's assigned automatically at
  // creation (see warrantyRepository.getNextWarrantyNumber).
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
  // Set only when the installer picked a match from the local car catalog
  // autocomplete — free text (car_id absent/null) always remains valid, per
  // the catalog-first-with-free-text-fallback decision.
  body('car_id').optional({ nullable: true }).isInt().withMessage('car_id must be an integer'),
  body('vehicle_production_year').isInt({ min: 1950, max: currentYear + 1 }).withMessage(`vehicle_production_year must be between 1950 and ${currentYear + 1}`),
  body('vehicle_plate_number').optional({ nullable: true, checkFalsy: true }),
  body('vehicle_vin').notEmpty(),
  body('vehicle_mileage').isInt({ min: 0, max: 4294967295 }).withMessage('vehicle_mileage must be between 0 and 4294967295'),
  body('owner_full_name').notEmpty(),
  // +998XXXXXXXXX exactly — EasyGas rejects other shapes, and this value is
  // forwarded verbatim in the warranty payload on approval (see
  // easyGasWarrantySyncService.buildPayload). Same shared PHONE_REGEX
  // authRoutes already enforces for registration; rows created before this
  // rule are additionally guarded at sync time (syncWarrantyForm's pre-POST
  // phone check) so a legacy shape can still never reach EasyGas.
  body('owner_phone').notEmpty().matches(PHONE_REGEX).withMessage('A valid Uzbekistan phone number is required (+998XXXXXXXXX)'),
  // Exactly the 4 fixed equipment slots (Reducer/Cylinder/Controller/
  // Injector Rail) — completeness (all 4, no duplicates) and product
  // validity are enforced in warrantyService.resolveEquipment, since a
  // shape-only check here can't confirm the product actually exists.
  body('equipment').isArray({ min: 4, max: 4 }).withMessage('All 4 equipment types are required'),
  body('equipment.*.equipment_type').isIn(['REDUCER', 'CYLINDER', 'CONTROLLER', 'INJECTOR_RAIL']),
  // product_id is optional here (not just for cylinder) so the same rule
  // applies uniformly — resolveEquipment is the one place that actually
  // enforces "required unless it's a typed cylinder" (CYLINDER_MODEL_REQUIRED
  // otherwise), same pattern as the barcode-required check.
  body('equipment.*.product_id').optional({ nullable: true }).isInt().withMessage('Product id must be an integer when provided'),
  body('equipment.*.model').optional({ nullable: true }).trim().isLength({ max: 100 }).withMessage('Model must be 100 characters or fewer'),
  body('equipment.*.brand_name').optional({ nullable: true }).trim().isLength({ max: 150 }).withMessage('Brand name must be 150 characters or fewer'),
  // Manual Verification fields — the active workflow is DISABLED
  // (warrantyService ignores these fields entirely now; see the TEMPORARY
  // PRODUCT DECISION note there). The shape validators are deliberately
  // kept so an older cached client that still sends them gets its
  // submission accepted (the fields are simply not persisted) instead of a
  // validation rejection.
  body('equipment.*.manual_verification').optional().isBoolean().withMessage('manual_verification must be a boolean'),
  body('equipment.*.seller_name').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 255 }).withMessage('Seller name must be 255 characters or fewer'),
  body('equipment.*.seller_phone').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 20 }).withMessage('Seller phone must be 20 characters or fewer'),
  body('equipment.*.comment').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 1000 }).withMessage('Comment must be 1000 characters or fewer'),
  body('equipment.*.manual_verification_photo_filename').optional({ nullable: true, checkFalsy: true }).isLength({ max: 255 }).withMessage('Invalid photo reference'),
];

// Manual Verification workflow — admin review actions. notes optional on
// both approve and reject, matching registrationRequestRoutes' own reject
// validator exactly (not required even to reject).
const manualVerificationReviewRules = [
  body('notes').optional({ checkFalsy: true }).isLength({ max: 1000 }),
];

// Warranty status workflow — admin review of the warranty form itself, a
// separate action from manualVerificationReviewRules above. Same shape
// (notes optional either way).
const warrantyReviewRules = [
  body('notes').optional({ checkFalsy: true }).isLength({ max: 1000 }),
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

// Manual Verification review — HISTORICAL-ONLY: the active workflow can no
// longer produce a PENDING row, but these endpoints remain so warranties
// submitted under the old flow can still be resolved (see
// warrantyService.reviewManualVerification). ADMIN-only, same as every
// other review/approval action in this app (registration requests).
router.post('/equipment/:equipmentId/approve-verification', verifyToken, authorizeRole('ADMIN'), manualVerificationReviewRules, approveManualVerification);
router.post('/equipment/:equipmentId/reject-verification', verifyToken, authorizeRole('ADMIN'), manualVerificationReviewRules, rejectManualVerification);

// Warranty status workflow — admin reviews the warranty form itself
// (PENDING -> SUCCESSFUL/REJECTED). ADMIN-only, same as every other
// review/approval action in this app. Approving triggers the EasyGas sync
// exactly once, inside warrantyService.reviewWarrantyForm — never here.
router.post('/:formId/approve', verifyToken, authorizeRole('ADMIN'), warrantyReviewRules, approveWarrantyForm);
router.post('/:formId/reject', verifyToken, authorizeRole('ADMIN'), warrantyReviewRules, rejectWarrantyForm);

// Pre-upload endpoint for a Manual Verification equipment photo — any
// authenticated installer (uploaded mid-form-fill, before the warranty row
// itself exists yet — see warrantyController.uploadEquipmentPhoto's doc
// comment). The stream-back route is ADMIN-only, same split as registration
// photos (uploaded broadly, viewed only by an admin).
router.post('/equipment-photo', verifyToken, handleManualVerificationPhotoUpload, uploadEquipmentPhoto);
router.get('/equipment/:equipmentId/photo', verifyToken, authorizeRole('ADMIN'), streamEquipmentPhoto);

module.exports = router;
