const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required', errorCode: 'UNAUTHORIZED', timestamp: new Date().toISOString() });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token', errorCode: 'UNAUTHORIZED', timestamp: new Date().toISOString() });
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

module.exports = { verifyToken, authorizeRole };
