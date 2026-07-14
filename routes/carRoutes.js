const express = require('express');
const { searchCars } = require('../controllers/carController');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

router.use(verifyToken);

// Any authenticated role — installers search the vehicle catalog mid-form-fill.
router.get('/search', searchCars);

module.exports = router;
