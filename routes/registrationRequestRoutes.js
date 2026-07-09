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
router.post('/:id/approve', approveRegistrationRequest);
router.post('/:id/reject', [
  body('notes').optional({ checkFalsy: true }).isLength({ max: 1000 }),
], rejectRegistrationRequest);

module.exports = router;
