const express = require('express');
const { body } = require('express-validator');
const {
  getAllUsers,
  createUser,
  updateUser,
  disableUser,
  enableUser,
  setSuperAdmin,
  resetPassword,
  getUser
} = require('../controllers/userController');
const { verifyToken, authorizeRole, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(verifyToken, authorizeRole('ADMIN'));

router.get('/', getAllUsers);

router.post('/', [
  body('full_name').notEmpty().withMessage('Full name is required'),
  body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('phone').optional({ checkFalsy: true }),
  body('branch_id').optional({ checkFalsy: true }).isInt().withMessage('Invalid branch')
], createUser);

router.get('/:userId', getUser);

router.put('/:userId', [
  body('full_name').notEmpty().withMessage('Full name is required'),
  body('phone').optional({ checkFalsy: true }),
  body('branch_id').optional({ checkFalsy: true }).isInt().withMessage('Invalid branch')
], updateUser);

router.patch('/:userId/disable', disableUser);
router.patch('/:userId/enable', enableUser);

// Super Admin only — grants/revokes the points-configuration/manual-
// adjustment capability on another Admin account (see middleware/auth.js).
router.patch('/:userId/super-admin', requireSuperAdmin, [
  body('isSuperAdmin').isBoolean().withMessage('isSuperAdmin must be a boolean'),
], setSuperAdmin);

router.post('/:userId/reset-password', [
  body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], resetPassword);

module.exports = router;
