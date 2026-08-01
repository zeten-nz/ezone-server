const express = require('express');
const { body } = require('express-validator');
const {
  getAllBranches,
  getPublicBranches,
  createBranch,
  updateBranch,
  disableBranch,
  enableBranch,
} = require('../controllers/branchController');
const { verifyToken, authorizeRole } = require('../middleware/auth');

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

module.exports = router;
