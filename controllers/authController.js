const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/database');
const { validationResult } = require('express-validator');
const { verifyImageMagicBytes, PROFILE_UPLOAD_DIR } = require('../config/uploads');

// Registration no longer creates an active user — it creates a PENDING
// registration_requests row with zero permissions (can't log in, can't hit
// any API). An admin must explicitly approve it (see
// registrationRequestController.approveRegistrationRequest) before a real
// users row — and therefore any access at all — is created.
const register = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Photo is required', errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    if (!verifyImageMagicBytes(req.file.path)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ success: false, message: 'File is not a valid image', errorCode: 'INVALID_FILE_TYPE', timestamp: new Date().toISOString() });
    }

    const { first_name, last_name, region, district, branch_id, phone, username, password } = req.body;
    const connection = await pool.getConnection();

    const [branches] = await connection.execute('SELECT code FROM branches WHERE id = ? AND is_active = TRUE', [branch_id]);
    if (branches.length === 0) {
      connection.release();
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ success: false, message: 'Invalid branch', errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const [existingUsers] = await connection.execute(
      'SELECT id FROM users WHERE username = ?',
      [username.trim()]
    );
    if (existingUsers.length > 0) {
      connection.release();
      fs.unlink(req.file.path, () => {});
      return res.status(409).json({ success: false, message: 'Username is already taken', errorCode: 'CONFLICT', timestamp: new Date().toISOString() });
    }

    // A rejected applicant may reapply under the same username — only an
    // already-PENDING or already-APPROVED request blocks a new submission.
    const [existingRequests] = await connection.execute(
      `SELECT id FROM registration_requests
       WHERE username = ? AND status IN ('PENDING', 'APPROVED')`,
      [username.trim()]
    );
    if (existingRequests.length > 0) {
      connection.release();
      fs.unlink(req.file.path, () => {});
      return res.status(409).json({ success: false, message: 'A registration request for this username is already pending', errorCode: 'CONFLICT', timestamp: new Date().toISOString() });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // branch_code is kept alongside branch_id as an immutable audit snapshot
    // of which branch this was submitted under — the branches table remains
    // the source of truth for name/phone/location, editable independently.
    await connection.execute(
      `INSERT INTO registration_requests
        (first_name, last_name, region, district, branch_id, branch_code, phone, username, password_hash, photo_filename, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [
        first_name.trim(), last_name.trim(), region, district, branch_id, branches[0].code,
        phone.trim(), username.trim(), hashedPassword, req.file.filename,
      ]
    );

    connection.release();

    res.status(201).json({
      message: 'Registration request submitted successfully',
      status: 'PENDING',
    });
  } catch (error) {
    if (req.file) fs.unlink(req.file.path, () => {});
    next(error);
  }
};

const login = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { username, password } = req.body;
    const connection = await pool.getConnection();

    const [activeUsers] = await connection.execute(
      'SELECT * FROM users WHERE username = ? AND is_active = TRUE',
      [username]
    );

    if (activeUsers.length > 0) {
      const user = activeUsers[0];
      const passwordMatch = await bcrypt.compare(password, user.password);

      if (!passwordMatch) {
        connection.release();
        return res.status(401).json({ success: false, message: 'Invalid username or password', errorCode: 'INVALID_CREDENTIALS', timestamp: new Date().toISOString() });
      }

      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, full_name: user.full_name },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE || '7d' }
      );

      await connection.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

      connection.release();

      return res.json({
        message: 'Login successful',
        token,
        user: {
          id: user.id,
          full_name: user.full_name,
          username: user.username,
          role: user.role,
          phone: user.phone,
          branch_code: user.branch_code,
        },
      });
    }

    // No active user with this username. Before falling through to the
    // generic invalid-credentials response, check whether a *disabled*
    // users row exists (an admin-disabled employee account, unrelated to
    // the registration-request flow) — that case keeps today's exact
    // behavior (generic message), so it's never confused with a pending
    // or rejected registration request.
    const [anyUser] = await connection.execute(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );

    if (anyUser.length === 0) {
      // No users row at all — check for a registration request under this
      // username. The password must match the request's own hash before
      // revealing anything, so an unauthenticated guesser can never learn
      // whether a username has a pending/rejected request just by trying it.
      const [requests] = await connection.execute(
        'SELECT * FROM registration_requests WHERE username = ? ORDER BY created_at DESC LIMIT 1',
        [username]
      );

      if (requests.length > 0) {
        const request = requests[0];
        const passwordMatch = await bcrypt.compare(password, request.password_hash);

        if (passwordMatch) {
          connection.release();
          if (request.status === 'PENDING') {
            return res.status(403).json({ success: false, message: 'Your registration request is pending approval', errorCode: 'ACCOUNT_PENDING_APPROVAL', timestamp: new Date().toISOString() });
          }
          if (request.status === 'REJECTED') {
            return res.status(403).json({ success: false, message: 'Your registration request was rejected', errorCode: 'ACCOUNT_REJECTED', timestamp: new Date().toISOString() });
          }
          // APPROVED with no matching users row shouldn't happen (approval
          // always creates one) — fall through to the generic response.
        }
      }
    }

    connection.release();
    return res.status(401).json({ success: false, message: 'Invalid username or password', errorCode: 'INVALID_CREDENTIALS', timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
};

const changePassword = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    const connection = await pool.getConnection();
    const [users] = await connection.execute(
      'SELECT password FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, message: 'User not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    const passwordMatch = await bcrypt.compare(currentPassword, users[0].password);
    if (!passwordMatch) {
      connection.release();
      return res.status(401).json({ success: false, message: 'Current password is incorrect', errorCode: 'INVALID_CURRENT_PASSWORD', timestamp: new Date().toISOString() });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await connection.execute(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, userId]
    );

    connection.release();

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    next(error);
  }
};

const getProfile = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const connection = await pool.getConnection();

    // Branch region/city/district/phone (not just name) are included because
    // the warranty form's read-only summary shows exactly what will be
    // snapshotted onto a submission — see warrantyController.getEmployeeSnapshot.
    const [users] = await connection.execute(
      `SELECT u.id, u.full_name, u.first_name, u.last_name, u.username, u.phone, u.region, u.district,
              u.branch_code, u.branch_id, b.name AS branch_name, b.phone AS branch_phone,
              b.region AS branch_region, b.city AS branch_city, b.district AS branch_district,
              u.photo_filename, u.role, u.is_active, u.last_login_at, u.created_at
       FROM users u LEFT JOIN branches b ON u.branch_id = b.id
       WHERE u.id = ?`,
      [userId]
    );

    connection.release();

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    // The raw filename is an internal storage detail, not something the
    // client needs — it just needs to know whether GET /profile/photo will
    // return anything.
    const { photo_filename, ...profile } = users[0];
    res.json({ ...profile, has_photo: !!photo_filename });
  } catch (error) {
    next(error);
  }
};

/**
 * Streams the caller's OWN profile photo — scoped by req.user.id (from the
 * verified JWT), never a route param, so there's no way to request anyone
 * else's photo. Mirrors registrationRequestController.streamRegistrationPhoto's
 * authenticated-stream-not-express.static approach.
 */
const streamProfilePhoto = async (req, res, next) => {
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.execute(
      'SELECT photo_filename FROM users WHERE id = ?',
      [req.user.id]
    );
    connection.release();

    const photoFilename = users[0]?.photo_filename;
    if (!photoFilename) {
      return res.status(404).json({ success: false, message: 'No profile photo', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    // Defense-in-depth: this value is always server-generated (see
    // config/uploads.js), but guard against path traversal regardless.
    const safeName = path.basename(photoFilename);
    if (safeName !== photoFilename) {
      return res.status(400).json({ success: false, message: 'Invalid file reference', errorCode: 'INVALID_FILE', timestamp: new Date().toISOString() });
    }

    const filePath = path.join(PROFILE_UPLOAD_DIR, safeName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Photo not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    const ext = path.extname(safeName).toLowerCase();
    const contentType = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    next(error);
  }
};

/** Replaces the caller's own profile photo, deleting the previous file (if any). */
const updateProfilePhoto = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Photo is required', errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    if (!verifyImageMagicBytes(req.file.path)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ success: false, message: 'File is not a valid image', errorCode: 'INVALID_FILE_TYPE', timestamp: new Date().toISOString() });
    }

    const connection = await pool.getConnection();
    const [users] = await connection.execute('SELECT photo_filename FROM users WHERE id = ?', [req.user.id]);
    const previousFilename = users[0]?.photo_filename;

    await connection.execute('UPDATE users SET photo_filename = ? WHERE id = ?', [req.file.filename, req.user.id]);
    connection.release();

    if (previousFilename) {
      fs.unlink(path.join(PROFILE_UPLOAD_DIR, path.basename(previousFilename)), () => {});
    }

    res.json({ message: 'Profile photo updated successfully' });
  } catch (error) {
    if (req.file) fs.unlink(req.file.path, () => {});
    next(error);
  }
};

/** Removes the caller's own profile photo — no error if there wasn't one. */
const removeProfilePhoto = async (req, res, next) => {
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.execute('SELECT photo_filename FROM users WHERE id = ?', [req.user.id]);
    const previousFilename = users[0]?.photo_filename;

    await connection.execute('UPDATE users SET photo_filename = NULL WHERE id = ?', [req.user.id]);
    connection.release();

    if (previousFilename) {
      fs.unlink(path.join(PROFILE_UPLOAD_DIR, path.basename(previousFilename)), () => {});
    }

    res.json({ message: 'Profile photo removed successfully' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  register,
  login,
  changePassword,
  getProfile,
  streamProfilePhoto,
  updateProfilePhoto,
  removeProfilePhoto,
};
