const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

// JWT stays fully stateless — no session store, no revocation list. Instead,
// every authenticated request re-checks the token's subject against the
// database (one indexed primary-key lookup via pool.execute(), the same
// acquire/execute/release-in-one-call idiom already used by the EasyGas sync
// services) so that a deactivated account, or a role/is_super_admin change,
// takes effect on the very next request — not only once the token's own
// JWT_EXPIRE (default 7d) naturally elapses. role/is_super_admin from the
// token payload are deliberately discarded in favor of the fresh DB values;
// only identity fields (id/username/full_name) come from the token itself.
const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required', errorCode: 'UNAUTHORIZED', timestamp: new Date().toISOString() });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token', errorCode: 'UNAUTHORIZED', timestamp: new Date().toISOString() });
  }

  try {
    const [rows] = await pool.execute(
      'SELECT is_active, role, is_super_admin FROM users WHERE id = ?',
      [decoded.id]
    );

    if (rows.length === 0 || !rows[0].is_active) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token', errorCode: 'UNAUTHORIZED', timestamp: new Date().toISOString() });
    }

    req.user = { ...decoded, role: rows[0].role, is_super_admin: !!rows[0].is_super_admin };
    next();
  } catch (error) {
    next(error);
  }
};


const authorizeRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'User not authenticated', errorCode: 'UNAUTHORIZED', timestamp: new Date().toISOString() });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied', errorCode: 'FORBIDDEN', timestamp: new Date().toISOString() });
    }

    next();
  };
};

// A Super Admin is an Admin with an extra capability flag (Phase 3 points
// config/manual adjustments only) — not a separate role, so this is checked
// in addition to authorizeRole('ADMIN'), never instead of it.
const requireSuperAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'User not authenticated', errorCode: 'UNAUTHORIZED', timestamp: new Date().toISOString() });
  }
  if (req.user.role !== 'ADMIN' || !req.user.is_super_admin) {
    return res.status(403).json({ success: false, message: 'Access denied', errorCode: 'FORBIDDEN', timestamp: new Date().toISOString() });
  }
  next();
};

module.exports = { verifyToken, authorizeRole, requireSuperAdmin };
