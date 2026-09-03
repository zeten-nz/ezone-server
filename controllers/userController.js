const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const { validationResult } = require('express-validator');
const AppError = require('../utils/AppError');
const managedEmployeeService = require('../services/managedEmployeeService');
const { logBranchClassification } = managedEmployeeService; // one shared audit logger (Beta-2.1)

const sendAppError = (res, error) => {
  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    errorCode: error.errorCode,
    timestamp: new Date().toISOString(),
  });
};

const getAllUsers = async (req, res, next) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [users] = await connection.execute(
      `SELECT u.id, u.full_name, u.username, u.phone, u.branch_code, u.branch_id, b.name AS branch_name,
              u.role, u.is_super_admin, u.is_active, u.created_at
       FROM users u LEFT JOIN branches b ON u.branch_id = b.id
       ORDER BY u.created_at DESC`
    );
    res.json(users);
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const createUser = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { full_name, username, password, phone, branch_id } = req.body;
    connection = await pool.getConnection();

    const [existing] = await connection.execute(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );

    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Username already exists', errorCode: 'CONFLICT', timestamp: new Date().toISOString() });
    }

    const hashedPassword = await bcrypt.hash(password, 10); // hashed BEFORE the transaction — never hold a row lock through CPU work

    // Managed-employee enforcement + branch classification and the user
    // INSERT form ONE transaction (Beta-2): the branch row is locked FOR
    // UPDATE inside enforceForCreate, so "classify branch" and "create
    // user" commit or roll back together — never a user without its
    // classification, never a classification for a rolled-back user.
    await connection.beginTransaction();
    let insertedId;
    let classification = null;
    try {
      ({ classification } = await managedEmployeeService.enforceForCreate(connection, {
        role: 'EMPLOYEE', // this endpoint only ever creates EMPLOYEE accounts
        username,
        branchId: branch_id || null,
      }));

      const [insertResult] = await connection.execute(
        'INSERT INTO users (full_name, username, password, phone, branch_id, role, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [full_name, username, hashedPassword, phone ?? null, branch_id || null, 'EMPLOYEE', true]
      );
      insertedId = insertResult.insertId;

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }

    logBranchClassification({ classification, actorId: req.user.id, employeeUsername: username, employeeId: insertedId });
    res.status(201).json({ message: 'User created successfully' });
  } catch (error) {
    if (error instanceof AppError) {
      return sendAppError(res, error);
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const updateUser = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { userId } = req.params;
    const { full_name, phone, branch_id } = req.body;

    connection = await pool.getConnection();

    const [existingRows] = await connection.execute(
      'SELECT id, username, role, branch_id FROM users WHERE id = ?',
      [userId]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }
    const existingUser = existingRows[0];

    // Same one-transaction contract as createUser: branch classification
    // (when a BRANCH CHANGE triggers it — username/role are immutable via
    // this endpoint, and unchanged-branch edits are never enforced, so
    // legacy-named employees keep working for unrelated edits) and the user
    // UPDATE commit or roll back together.
    await connection.beginTransaction();
    let classification = null;
    try {
      ({ classification } = await managedEmployeeService.enforceForUpdate(connection, {
        existingUser,
        newBranchId: branch_id || null,
      }));

      const [result] = await connection.execute(
        'UPDATE users SET full_name = ?, phone = ?, branch_id = ? WHERE id = ?',
        [full_name, phone ?? null, branch_id || null, userId]
      );
      if (result.affectedRows === 0) {
        throw new AppError('User not found', 404, 'NOT_FOUND'); // deleted concurrently — rolls back any classification
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }

    logBranchClassification({ classification, actorId: req.user.id, employeeUsername: existingUser.username, employeeId: existingUser.id });
    res.json({ message: 'User updated successfully' });
  } catch (error) {
    if (error instanceof AppError) {
      return sendAppError(res, error);
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

// Shared by disableUser/enableUser below — the only difference between the
// two is the boolean they write, so this keeps that one real distinction in
// one place instead of two near-identical copies of the same query/response.
const setUserActive = (isActive) => async (req, res, next) => {
  let connection;
  try {
    const { userId } = req.params;
    connection = await pool.getConnection();

    const [result] = await connection.execute(
      'UPDATE users SET is_active = ? WHERE id = ? AND role = ?',
      [isActive, userId, 'EMPLOYEE']
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User not found, or is not an employee account', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    res.json({ message: isActive ? 'User enabled successfully' : 'User disabled successfully' });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const disableUser = setUserActive(false);
const enableUser = setUserActive(true);

// Grants/revokes the Super Admin capability flag — restricted to Super
// Admins themselves (route-level requireSuperAdmin), and only meaningful on
// an ADMIN account (an EMPLOYEE gaining this flag would have no routes that
// check it, but the WHERE clause keeps the invariant explicit regardless).
const setSuperAdmin = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { userId } = req.params;
    const { isSuperAdmin } = req.body;
    connection = await pool.getConnection();

    const [result] = await connection.execute(
      'UPDATE users SET is_super_admin = ? WHERE id = ? AND role = ?',
      [!!isSuperAdmin, userId, 'ADMIN']
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User not found, or is not an admin account', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    res.json({ message: isSuperAdmin ? 'Super Admin granted' : 'Super Admin revoked' });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const resetPassword = async (req, res, next) => {
  let connection;
  try {
    const { userId } = req.params;
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({ success: false, message: 'New password required', errorCode: 'BAD_REQUEST', timestamp: new Date().toISOString() });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    connection = await pool.getConnection();

    const [result] = await connection.execute(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const getUser = async (req, res, next) => {
  let connection;
  try {
    const { userId } = req.params;
    connection = await pool.getConnection();

    const [users] = await connection.execute(
      `SELECT u.id, u.full_name, u.username, u.phone, u.branch_code, u.branch_id, b.name AS branch_name,
              u.role, u.is_super_admin, u.is_active
       FROM users u LEFT JOIN branches b ON u.branch_id = b.id
       WHERE u.id = ?`,
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    res.json(users[0]);
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getAllUsers,
  createUser,
  updateUser,
  disableUser,
  enableUser,
  setSuperAdmin,
  resetPassword,
  getUser
};
