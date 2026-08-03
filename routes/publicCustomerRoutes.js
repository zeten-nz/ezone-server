const express = require('express');
const { body } = require('express-validator');
const { getWarrantiesByPhone } = require('../controllers/publicCustomerController');

const router = express.Router();

// Fully public — no verifyToken. Removed once (docs/09-security.md) after
// being confirmed as an unauthenticated PII leak; restored as a deliberate,
// explicitly-accepted trade-off. Do not add auth here without being asked.
router.post('/warranties', [
  body('phone').trim().notEmpty().withMessage('Phone number is required'),
], getWarrantiesByPhone);

module.exports = router;
