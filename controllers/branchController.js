const { pool } = require('../config/database');
const { validationResult } = require('express-validator');
const AppError = require('../utils/AppError');
const managedEmployeeService = require('../services/managedEmployeeService');

const getAllBranches = async (req, res, next) => {
  let connection;
  try {
    connection = await pool.getConnection();
    // branch_type (Beta-2): the persisted business classification — NULL =
    // unclassified. Read-only through this API: no branch endpoint accepts
    // branch_type as input (classification happens exclusively via the
    // managed-employee onboarding flow, never via branch CRUD/mass
    // assignment). The public /branches/public endpoint deliberately does
    // NOT expose it.
    const [branches] = await connection.execute(
      'SELECT id, code, name, phone, region, district, city, is_active, branch_type, created_at FROM branches ORDER BY name'
    );
    res.json(branches);
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Minimal, unauthenticated branch list — the registration form needs to
 * offer a branch picker before the applicant has any account/role at all.
 * Deliberately excludes phone/region/district/is_active; only active
 * branches are offered.
 */
const getPublicBranches = async (req, res, next) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [branches] = await connection.execute(
      'SELECT id, code, name FROM branches WHERE is_active = TRUE ORDER BY name'
    );
    res.json(branches);
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const createBranch = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { code, name, phone, region, district, city } = req.body;
    connection = await pool.getConnection();

    const [existing] = await connection.execute('SELECT id FROM branches WHERE code = ?', [code.trim()]);
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Branch code already exists', errorCode: 'CONFLICT', timestamp: new Date().toISOString() });
    }

    await connection.execute(
      'INSERT INTO branches (code, name, phone, region, district, city) VALUES (?, ?, ?, ?, ?, ?)',
      [code.trim(), name.trim(), phone?.trim() || null, region || null, district || null, city?.trim() || null]
    );

    res.status(201).json({ message: 'Branch created successfully' });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

// Branch code is never editable after creation — it's the stable identifier
// historical warranty_forms/users rows may still reference; same convention
// as usernames elsewhere in this codebase.
const updateBranch = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { branchId } = req.params;
    const { name, phone, region, district, city } = req.body;
    connection = await pool.getConnection();

    const [result] = await connection.execute(
      'UPDATE branches SET name = ?, phone = ?, region = ?, district = ?, city = ? WHERE id = ?',
      [name.trim(), phone?.trim() || null, region || null, district || null, city?.trim() || null, branchId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Branch not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    res.json({ message: 'Branch updated successfully' });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

// Shared by disableBranch/enableBranch — same pattern as
// userController.setUserActive.
const setBranchActive = (isActive) => async (req, res, next) => {
  let connection;
  try {
    const { branchId } = req.params;
    connection = await pool.getConnection();

    const [result] = await connection.execute('UPDATE branches SET is_active = ? WHERE id = ?', [isActive, branchId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Branch not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    res.json({ message: isActive ? 'Branch enabled successfully' : 'Branch disabled successfully' });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const disableBranch = setBranchActive(false);
const enableBranch = setBranchActive(true);

/**
 * PATCH /api/branches/:branchId/reclassify (Beta-2.1) — the EXPLICIT
 * corrective reclassification workflow, Super-Admin-only (route-level
 * requireSuperAdmin — the same established capability gate points config
 * and inventory manual operations use). This is deliberately NOT part of
 * ordinary branch editing: normal classification happens exclusively
 * through managed employee onboarding, and this endpoint mutates ONLY
 * branch_type (body: { branch_type: EASYGAS|STAG_SERVICE|OTHER_SERVICE|null,
 * null = reset to unclassified }) — no other branch field is reachable
 * here. All consistency/conflict/locking rules live in
 * managedEmployeeService.reclassifyBranch (one business rule, never
 * duplicated).
 */
const reclassifyBranch = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { branchId } = req.params;
    const targetType = req.body.branch_type ?? null;

    connection = await pool.getConnection();
    await connection.beginTransaction();
    let outcome;
    try {
      outcome = await managedEmployeeService.reclassifyBranch(connection, { branchId, targetType });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }

    if (outcome.changed) {
      // Mandatory audit (no generic persistent audit table exists — the
      // structured operational log is this codebase's audit convention).
      console.log(
        `[Branch Reclassification] action=BRANCH_RECLASSIFICATION branch ${outcome.branch.code} (id ${outcome.branch.id}): ` +
        `${outcome.oldType ?? 'NULL'} -> ${outcome.newType ?? 'NULL'} by super-admin #${req.user.id}` +
        (outcome.legacyCount > 0 ? ` (note: ${outcome.legacyCount} legacy/unparsed employee username(s) provided no type evidence)` : '')
      );
    }

    res.json({
      message: outcome.changed ? 'Branch reclassified' : 'Branch type unchanged',
      old_type: outcome.oldType,
      new_type: outcome.newType,
      changed: outcome.changed,
    });
  } catch (error) {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ success: false, message: error.message, errorCode: error.errorCode, timestamp: new Date().toISOString() });
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getAllBranches,
  getPublicBranches,
  createBranch,
  updateBranch,
  disableBranch,
  enableBranch,
  reclassifyBranch,
};
