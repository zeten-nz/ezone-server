const express = require('express');
const { body } = require('express-validator');
const {
  register, login, changePassword, getProfile,
  streamProfilePhoto, updateProfilePhoto, removeProfilePhoto,
} = require('../controllers/authController');
const { verifyToken } = require('../middleware/auth');
const { handleRegistrationPhotoUpload, handleProfilePhotoUpload } = require('../config/uploads');
const { PHONE_REGEX } = require('../config/validation');

const router = express.Router();

// multer must run first — it's what parses the multipart body at all (the
// global express.json()/urlencoded() in server.js never touch this route).
router.post('/register', handleRegistrationPhotoUpload, [
  body('first_name').trim().notEmpty().withMessage('First name is required'),
  body('last_name').trim().notEmpty().withMessage('Last name is required'),
  body('region').trim().notEmpty().withMessage('Region is required'),
  body('district').trim().notEmpty().withMessage('District is required'),
  body('branch_id').notEmpty().withMessage('Branch is required').isInt().withMessage('Invalid branch'),
  body('phone').matches(PHONE_REGEX).withMessage('A valid Uzbekistan phone number is required'),
  body('username').trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
], register);

router.post('/login', [
  body('username').notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required')
], login);

router.post('/change-password', verifyToken, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters')
], changePassword);

router.get('/profile', verifyToken, getProfile);

// Self-service profile photo — scoped entirely by the verified JWT
// (req.user.id), never a route param, so there's no other-user access path.
router.get('/profile/photo', verifyToken, streamProfilePhoto);
router.post('/profile/photo', verifyToken, handleProfilePhotoUpload, updateProfilePhoto);
router.delete('/profile/photo', verifyToken, removeProfilePhoto);

module.exports = router;
