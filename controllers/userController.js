const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const { validationResult } = require('express-validator');

const getAllUsers = async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.execute(
      'SELECT id, full_name, username, phone, branch_code, role, is_active, created_at FROM users ORDER BY created_at DESC'
    );
    connection.release();

    res.json(users);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

const createUser = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { full_name, username, password, phone, branch_code } = req.body;
    const connection = await pool.getConnection();

    const [existing] = await connection.execute(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );

    if (existing.length > 0) {
      connection.release();
      return res.status(400).json({ message: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await connection.execute(
      'INSERT INTO users (full_name, username, password, phone, branch_code, role, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [full_name, username, hashedPassword, phone, branch_code, 'EMPLOYEE', true]
    );

    connection.release();

    res.status(201).json({ message: 'User created successfully' });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

const updateUser = async (req, res) => {
  try {
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
    console.error('Update user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

const disableUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const connection = await pool.getConnection();

    await connection.execute(
      'UPDATE users SET is_active = FALSE WHERE id = ? AND role = ?',
      [userId, 'EMPLOYEE']
    );

    connection.release();

    res.json({ message: 'User disabled successfully' });
  } catch (error) {
    console.error('Disable user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { userId } = req.params;
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({ message: 'New password required' });
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
    console.error('Reset password error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

const getUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const connection = await pool.getConnection();

    const [users] = await connection.execute(
      'SELECT id, full_name, username, phone, branch_code, role, is_active FROM users WHERE id = ?',
      [userId]
    );

    connection.release();

    if (users.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(users[0]);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  getAllUsers,
  createUser,
  updateUser,
  disableUser,
  resetPassword,
  getUser
};
