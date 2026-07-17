const express = require('express');
const { body } = require('express-validator');
const {
  getMyPoints,
  getInstallerPoints,
  getProductConfigs,
  setProductConfig,
  createAdjustment,
} = require('../controllers/pointsController');
const { verifyToken, authorizeRole, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(verifyToken);

// Any authenticated role — an installer views only their own ledger, always
// scoped by req.user.id server-side (see pointsController.getMyPoints).
router.get('/mine', getMyPoints);

router.use(authorizeRole('ADMIN'));

router.get('/installer/:installerId', getInstallerPoints);
router.get('/configs', getProductConfigs);

// Super Admin only — configuring point values and creating manual
// adjustments are strictly more privileged than ordinary Admin capability
// (see middleware/auth.js's requireSuperAdmin).
router.put('/configs/:productId', requireSuperAdmin, [
  body('points').isInt({ min: 0 }).withMessage('Points must be a non-negative integer'),
], setProductConfig);

router.post('/adjustments', requireSuperAdmin, [
  body('installerId').isInt().withMessage('installerId is required'),
  body('points').isInt().withMessage('Points must be an integer'),
  body('type').isIn(['MANUAL_ADJUSTMENT', 'MANUAL_BONUS', 'MANUAL_PENALTY']).withMessage('Invalid transaction type'),
  body('reason').trim().notEmpty().withMessage('A reason is required'),
  body('idempotencyKey').optional({ checkFalsy: true }).isString(),
], createAdjustment);

module.exports = router;
