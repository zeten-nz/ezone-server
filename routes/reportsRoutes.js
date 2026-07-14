const express = require('express');
const {
  getTopInstallers,
  getMonthlyActivity,
  getProductsInstalled,
  getBranchRanking,
} = require('../controllers/reportsController');
const { verifyToken, authorizeRole } = require('../middleware/auth');

const router = express.Router();

router.use(verifyToken, authorizeRole('ADMIN'));

router.get('/top-installers', getTopInstallers);
router.get('/monthly-activity', getMonthlyActivity);
router.get('/products-installed', getProductsInstalled);
router.get('/branch-ranking', getBranchRanking);

module.exports = router;
