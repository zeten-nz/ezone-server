const express = require('express');
const { body } = require('express-validator');
const {
  getAllUsers,
  createUser,
  updateUser,
  disableUser,
  enableUser,
  resetPassword,
  getUser
} = require('../controllers/userController');
const { verifyToken, authorizeRole } = require('../middleware/auth');

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

router.post('/:userId/reset-password', [
  body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], resetPassword);

module.exports = router;
