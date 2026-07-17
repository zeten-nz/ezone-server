const express = require('express');
const { body } = require('express-validator');
const { getWarrantiesByPhone } = require('../controllers/publicCustomerController');

const router = express.Router();

// No verifyToken/authorizeRole here, deliberately — the caller is another
// platform's backend, not a logged-in staff member or a customer we
// authenticate ourselves. It sends only a phone number, already verified
// on its own side (see the architecture review this endpoint was designed
// against). Still covered by server.js's existing global rate limiter,
// since this router is mounted under /api like everything else.
router.post(
  '/warranties',
  [body('phone').trim().notEmpty().withMessage('phone is required')],
  getWarrantiesByPhone
);

module.exports = router;
