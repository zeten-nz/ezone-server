const express = require('express');
const { body } = require('express-validator');
const {
  getAllRegistrationRequests,
  getRegistrationRequestDetail,
  streamRegistrationPhoto,
  approveRegistrationRequest,
  rejectRegistrationRequest,
} = require('../controllers/registrationRequestController');
const { verifyToken, authorizeRole } = require('../middleware/auth');

const router = express.Router();

router.use(verifyToken, authorizeRole('ADMIN'));

router.get('/', getAllRegistrationRequests);
router.get('/:id', getRegistrationRequestDetail);
router.get('/:id/photo', streamRegistrationPhoto);
// Beta-2.1: the admin supplies the FINAL managed employee username (and may
// override the applicant's branch) at approval time — shape-validated here,
// business-validated by managedEmployeeService inside the approval
// transaction (see approveRegistrationRequest).
router.post('/:id/approve', [
  body('username').optional({ checkFalsy: true }).isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('branch_id').optional({ checkFalsy: true }).isInt().withMessage('Invalid branch'),
], approveRegistrationRequest);
router.post('/:id/reject', [
  body('notes').optional({ checkFalsy: true }).isLength({ max: 1000 }),
], rejectRegistrationRequest);

module.exports = router;
