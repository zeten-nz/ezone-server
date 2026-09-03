const express = require('express');
const { body } = require('express-validator');
const {
  getAllBranches,
  getPublicBranches,
  createBranch,
  updateBranch,
  disableBranch,
  enableBranch,
  reclassifyBranch,
} = require('../controllers/branchController');
const { verifyToken, authorizeRole, requireSuperAdmin } = require('../middleware/auth');
const { BRANCH_TYPES } = require('../config/branchTypes');

const router = express.Router();

// Registered before the verifyToken/authorizeRole gate below — Register.jsx
// needs a branch picker before the applicant has any account at all.
router.get('/public', getPublicBranches);

router.use(verifyToken, authorizeRole('ADMIN'));

router.get('/', getAllBranches);

router.post('/', [
  body('code').trim().notEmpty().withMessage('Branch code is required'),
  body('name').trim().notEmpty().withMessage('Branch name is required'),
], createBranch);

router.put('/:branchId', [
  body('name').trim().notEmpty().withMessage('Branch name is required'),
], updateBranch);

router.patch('/:branchId/disable', disableBranch);
router.patch('/:branchId/enable', enableBranch);

// Beta-2.1: EXPLICIT corrective reclassification — Super-Admin-only (same
// capability gate as points config / inventory manual ops). body.branch_type
// is one of the canonical types, or null to reset to unclassified; every
// consistency rule (managed-employee evidence, locking) is enforced in
// managedEmployeeService.reclassifyBranch.
router.patch('/:branchId/reclassify', requireSuperAdmin, [
  body('branch_type').custom((value) => {
    if (value === null || value === undefined || BRANCH_TYPES.includes(value)) return true;
    throw new Error(`branch_type must be one of ${BRANCH_TYPES.join(', ')} or null`);
  }),
], reclassifyBranch);

module.exports = router;
