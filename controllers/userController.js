const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const { validationResult } = require('express-validator');

const getAllUsers = async (req, res, next) => {
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.execute(
      'SELECT id, full_name, username, phone, branch_code, role, is_active, created_at FROM users ORDER BY created_at DESC'
    );
    connection.release();

    res.json(users);
  } catch (error) {
    next(error);
  }
};

const createUser = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { full_name, username, password, phone, branch_code } = req.body;
    const connection = await pool.getConnection();

    const [existing] = await connection.execute(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );

    if (existing.length > 0) {
      connection.release();
      return res.status(409).json({ success: false, message: 'Username already exists', errorCode: 'CONFLICT', timestamp: new Date().toISOString() });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await connection.execute(
      'INSERT INTO users (full_name, username, password, phone, branch_code, role, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [full_name, username, hashedPassword, phone, branch_code, 'EMPLOYEE', true]
    );

    connection.release();

    res.status(201).json({ message: 'User created successfully' });
  } catch (error) {
    next(error);
  }
};

const updateUser = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { userId } = req.params;
    const { full_name, phone, branch_code } = req.body;

    const connection = await pool.getConnection();

    await connection.execute(
      'UPDATE users SET full_name = ?, phone = ?, branch_code = ? WHERE id = ?',
      [full_name, phone, branch_code, userId]
    );

    connection.release();

    res.json({ message: 'User updated successfully' });
  } catch (error) {
    next(error);
  }
};

// Shared by disableUser/enableUser below — the only difference between the
// two is the boolean they write, so this keeps that one real distinction in
// one place instead of two near-identical copies of the same query/response.
const setUserActive = (isActive) => async (req, res, next) => {
  try {
    const { userId } = req.params;
    const connection = await pool.getConnection();

    await connection.execute(
      'UPDATE users SET is_active = ? WHERE id = ? AND role = ?',
      [isActive, userId, 'EMPLOYEE']
    );

    connection.release();

    res.json({ message: isActive ? 'User enabled successfully' : 'User disabled successfully' });
  } catch (error) {
    next(error);
  }
};

const disableUser = setUserActive(false);
const enableUser = setUserActive(true);

const resetPassword = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({ success: false, message: 'New password required', errorCode: 'BAD_REQUEST', timestamp: new Date().toISOString() });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const connection = await pool.getConnection();

    await connection.execute(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, userId]
    );

    connection.release();

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    next(error);
  }
};

const getUser = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const connection = await pool.getConnection();

    const [users] = await connection.execute(
      'SELECT id, full_name, username, phone, branch_code, role, is_active FROM users WHERE id = ?',
      [userId]
    );

    connection.release();

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    res.json(users[0]);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllUsers,
  createUser,
  updateUser,
  disableUser,
  enableUser,
  resetPassword,
  getUser
};
