const { pool } = require('../config/database');
const { validationResult } = require('express-validator');
const easyGasCatalogClient = require('../services/easyGasCatalogClient');

const getAllBranches = async (req, res, next) => {
  try {
    const connection = await pool.getConnection();
    const [branches] = await connection.execute(
      'SELECT id, code, easygas_stag_code, name, phone, region, district, city, is_active, created_at FROM branches ORDER BY name'
    );
    connection.release();
    res.json(branches);
  } catch (error) {
    next(error);
  }
};

/**
 * Minimal, unauthenticated branch list — the registration form needs to
 * offer a branch picker before the applicant has any account/role at all.
 * Deliberately excludes phone/region/district/is_active; only active
 * branches are offered.
 */
const getPublicBranches = async (req, res, next) => {
  try {
    const connection = await pool.getConnection();
    const [branches] = await connection.execute(
      'SELECT id, code, name FROM branches WHERE is_active = TRUE ORDER BY name'
    );
    connection.release();
    res.json(branches);
  } catch (error) {
    next(error);
  }
};

const createBranch = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { code, name, phone, region, district, city, easygas_stag_code } = req.body;
    const connection = await pool.getConnection();

    const [existing] = await connection.execute('SELECT id FROM branches WHERE code = ?', [code.trim()]);
    if (existing.length > 0) {
      connection.release();
      return res.status(409).json({ success: false, message: 'Branch code already exists', errorCode: 'CONFLICT', timestamp: new Date().toISOString() });
    }

    await connection.execute(
      'INSERT INTO branches (code, name, phone, region, district, city, easygas_stag_code) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [code.trim(), name.trim(), phone?.trim() || null, region || null, district || null, city?.trim() || null, easygas_stag_code?.trim() || null]
    );
    connection.release();

    res.status(201).json({ message: 'Branch created successfully' });
  } catch (error) {
    next(error);
  }
};

// Branch code is never editable after creation — it's the stable identifier
// historical warranty_forms/users rows may still reference; same convention
// as usernames elsewhere in this codebase.
const updateBranch = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { branchId } = req.params;
    const { name, phone, region, district, city } = req.body;
    const connection = await pool.getConnection();

    // easygas_stag_code is only included in the SET clause when the request
    // body actually contains the key — the current frontend's branch edit
    // form doesn't send it at all yet, and treating "omitted" the same as
    // "sent empty" would silently wipe any stag_code already set (e.g. via
    // GET /api/branches/easygas + a direct update) every time an admin edits
    // a branch's name/phone/region through the existing UI.
    const hasStagCode = Object.prototype.hasOwnProperty.call(req.body, 'easygas_stag_code');
    if (hasStagCode) {
      await connection.execute(
        'UPDATE branches SET name = ?, phone = ?, region = ?, district = ?, city = ?, easygas_stag_code = ? WHERE id = ?',
        [name.trim(), phone?.trim() || null, region || null, district || null, city?.trim() || null, req.body.easygas_stag_code?.trim() || null, branchId]
      );
    } else {
      await connection.execute(
        'UPDATE branches SET name = ?, phone = ?, region = ?, district = ?, city = ? WHERE id = ?',
        [name.trim(), phone?.trim() || null, region || null, district || null, city?.trim() || null, branchId]
      );
    }
    connection.release();

    res.json({ message: 'Branch updated successfully' });
  } catch (error) {
    next(error);
  }
};

// Shared by disableBranch/enableBranch — same pattern as
// userController.setUserActive.
const setBranchActive = (isActive) => async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const connection = await pool.getConnection();

    await connection.execute('UPDATE branches SET is_active = ? WHERE id = ?', [isActive, branchId]);

    connection.release();
    res.json({ message: isActive ? 'Branch enabled successfully' : 'Branch disabled successfully' });
  } catch (error) {
    next(error);
  }
};

const disableBranch = setBranchActive(false);
const enableBranch = setBranchActive(true);

/**
 * Live passthrough of EasyGas's real branch list (stag_code/name/region_id)
 * — no local caching/table. An admin uses this to look up the right
 * stag_code and enter it via updateBranch; not a sync path.
 */
const getEasyGasBranches = async (req, res, next) => {
  try {
    const result = await easyGasCatalogClient.getBranches();
    if (!result.ok) {
      return res.status(502).json({
        success: false,
        message: 'Could not reach EasyGas to fetch branch codes',
        errorCode: 'EASYGAS_UNAVAILABLE',
        timestamp: new Date().toISOString(),
      });
    }
    res.json(result.data?.data || []);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllBranches,
  getPublicBranches,
  getEasyGasBranches,
  createBranch,
  updateBranch,
  disableBranch,
  enableBranch,
};
