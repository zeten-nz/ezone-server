const express = require('express');
const { runCatalogSync, getCatalogSyncStatus } = require('../controllers/catalogSyncController');
const { verifyToken, authorizeRole } = require('../middleware/auth');

const router = express.Router();

router.use(verifyToken);
router.use(authorizeRole('ADMIN'));

router.get('/status', getCatalogSyncStatus);
router.post('/run', runCatalogSync);

module.exports = router;
