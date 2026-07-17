const path = require('path');
const fs = require('fs');
const { pool } = require('../config/database');
const { UPLOAD_DIR, PROFILE_UPLOAD_DIR } = require('../config/uploads');

const getAllRegistrationRequests = async (req, res, next) => {
  try {
    const connection = await pool.getConnection();

    const [requests] = await connection.execute(
      `SELECT rr.id, rr.first_name, rr.last_name, rr.region, rr.district, rr.branch_code,
              rr.branch_id, b.name AS branch_name,
              rr.phone, rr.username, rr.status, rr.notes, rr.created_at, rr.reviewed_at,
              rr.reviewed_by, ru.full_name AS reviewer_name
       FROM registration_requests rr
       LEFT JOIN users ru ON rr.reviewed_by = ru.id
       LEFT JOIN branches b ON rr.branch_id = b.id
       ORDER BY rr.created_at DESC`
    );

    connection.release();
    res.json(requests);
  } catch (error) {
    next(error);
  }
};

const getRegistrationRequestDetail = async (req, res, next) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();

    const [requests] = await connection.execute(
      `SELECT rr.id, rr.first_name, rr.last_name, rr.region, rr.district, rr.branch_code,
              rr.branch_id, b.name AS branch_name,
              rr.phone, rr.username, rr.status, rr.notes, rr.created_at, rr.reviewed_at,
              rr.reviewed_by, ru.full_name AS reviewer_name
       FROM registration_requests rr
       LEFT JOIN users ru ON rr.reviewed_by = ru.id
       LEFT JOIN branches b ON rr.branch_id = b.id
       WHERE rr.id = ?`,
      [id]
    );

    connection.release();

    if (requests.length === 0) {
      return res.status(404).json({ success: false, message: 'Registration request not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    res.json(requests[0]);
  } catch (error) {
    next(error);
  }
};

/**
 * Streams the photo through an authenticated (ADMIN-only, via the route's
 * middleware) route rather than express.static — a registration photo is
 * PII of a not-yet-employee, and a public static mount would make it
 * fetchable by anyone with the URL.
 */
const streamRegistrationPhoto = async (req, res, next) => {
  try {
    const { id } = req.params;
    const connection = await pool.getConnection();

    const [requests] = await connection.execute(
      'SELECT photo_filename FROM registration_requests WHERE id = ?',
      [id]
    );

    connection.release();

    if (requests.length === 0) {
      return res.status(404).json({ success: false, message: 'Registration request not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    const { photo_filename: photoFilename } = requests[0];

    // Defense-in-depth: this value is always server-generated (see
    // config/uploads.js), but guard against path traversal regardless in
    // case it's ever hand-edited in the DB.
    const safeName = path.basename(photoFilename);
    if (safeName !== photoFilename) {
      return res.status(400).json({ success: false, message: 'Invalid file reference', errorCode: 'INVALID_FILE', timestamp: new Date().toISOString() });
    }

    const filePath = path.join(UPLOAD_DIR, safeName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Photo not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    const ext = path.extname(safeName).toLowerCase();
    const contentType = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, no-store');

    // .pipe() does not forward source-stream errors to the response — an
    // unhandled 'error' event here throws and crashes the whole process
    // (see the identical fix in authController.js's streamProfilePhoto).
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(404).json({ success: false, message: 'Photo not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
};

const approveRegistrationRequest = async (req, res, next) => {
  let connection;
  try {
    const { id } = req.params;
    connection = await pool.getConnection();

    const [requests] = await connection.execute(
      'SELECT * FROM registration_requests WHERE id = ?',
      [id]
    );

    if (requests.length === 0) {
      return res.status(404).json({ success: false, message: 'Registration request not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    const request = requests[0];

    if (request.status !== 'PENDING') {
      return res.status(409).json({ success: false, message: 'This request has already been reviewed', errorCode: 'INVALID_STATE', timestamp: new Date().toISOString() });
    }

    const [existingUsers] = await connection.execute(
      'SELECT id FROM users WHERE username = ?',
      [request.username]
    );
    if (existingUsers.length > 0) {
      return res.status(409).json({ success: false, message: 'Username already exists', errorCode: 'CONFLICT', timestamp: new Date().toISOString() });
    }

    const fullName = `${request.first_name} ${request.last_name}`.trim();

    await connection.beginTransaction();

    await connection.execute(
      `INSERT INTO users
        (full_name, first_name, last_name, username, password, phone, region, district, branch_id, branch_code, photo_filename, role, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fullName, request.first_name, request.last_name, request.username, request.password_hash,
        request.phone, request.region, request.district, request.branch_id, request.branch_code, request.photo_filename,
        'EMPLOYEE', true,
      ]
    );

    // Guarded on status = 'PENDING', not a bare `WHERE id = ?` — the earlier
    // check (line ~122) only rules out the common case; it can't see a
    // concurrent reject that commits between that read and this write. If
    // this UPDATE matches zero rows, someone else already reviewed this
    // request in the meantime, so roll back (undoing the users INSERT
    // above too) instead of silently creating an account for a request
    // that's actually REJECTED, or vice versa.
    const [updateResult] = await connection.execute(
      'UPDATE registration_requests SET status = ?, reviewed_at = NOW(), reviewed_by = ? WHERE id = ? AND status = ?',
      ['APPROVED', req.user.id, id, 'PENDING']
    );

    if (updateResult.affectedRows === 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'This request has already been reviewed', errorCode: 'INVALID_STATE', timestamp: new Date().toISOString() });
    }

    await connection.commit();

    // Best-effort: copy (not move) the applicant's photo into the
    // profile-photos directory so the new user has their own independent
    // copy to replace/remove freely via the profile photo endpoints. The
    // original stays in the registration-photos directory untouched — an
    // admin can still open this (now APPROVED) request's detail view later
    // and see exactly what was originally submitted; moving the file would
    // have silently broken that view the moment approval happened. Non-fatal
    // either way — the account is already fully usable even if this fails.
    if (request.photo_filename) {
      const from = path.join(UPLOAD_DIR, request.photo_filename);
      const to = path.join(PROFILE_UPLOAD_DIR, request.photo_filename);
      fs.copyFile(from, to, (err) => {
        if (err) console.error(`[registration-approve] Failed to copy photo ${request.photo_filename}:`, err.message);
      });
    }

    res.json({ message: 'Registration request approved successfully' });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch { /* connection already broken */ }
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const rejectRegistrationRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const connection = await pool.getConnection();

    const [requests] = await connection.execute(
      'SELECT status FROM registration_requests WHERE id = ?',
      [id]
    );

    if (requests.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Registration request not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    if (requests[0].status !== 'PENDING') {
      connection.release();
      return res.status(409).json({ success: false, message: 'This request has already been reviewed', errorCode: 'INVALID_STATE', timestamp: new Date().toISOString() });
    }

    // Guarded on status = 'PENDING' — closes the same race approve() guards
    // against: a concurrent approve() can commit between the read above and
    // this write, and without this guard, this UPDATE would blindly stamp
    // 'REJECTED' over an already-APPROVED request whose users row now
    // exists — the audit trail would say rejected while the account is
    // actually live.
    const [updateResult] = await connection.execute(
      'UPDATE registration_requests SET status = ?, notes = ?, reviewed_at = NOW(), reviewed_by = ? WHERE id = ? AND status = ?',
      ['REJECTED', notes?.trim() || null, req.user.id, id, 'PENDING']
    );

    connection.release();

    if (updateResult.affectedRows === 0) {
      return res.status(409).json({ success: false, message: 'This request has already been reviewed', errorCode: 'INVALID_STATE', timestamp: new Date().toISOString() });
    }

    res.json({ message: 'Registration request rejected' });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllRegistrationRequests,
  getRegistrationRequestDetail,
  streamRegistrationPhoto,
  approveRegistrationRequest,
  rejectRegistrationRequest,
};
