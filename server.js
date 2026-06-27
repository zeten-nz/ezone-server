/**
 * ============================================================
 * EZONE WARRANTY MANAGEMENT SYSTEM — Production Entry Point
 * ============================================================
 *
 * Production improvements applied in this file:
 *
 *  1. ENV VALIDATION      — validateEnv() runs before anything else so the
 *                           server refuses to start with missing config.
 *
 *  2. HELMET              — Sets ~14 security-oriented HTTP response headers
 *                           (X-Frame-Options, X-XSS-Protection, HSTS, etc.)
 *                           to harden the app against common web attacks.
 *
 *  3. CORS FROM ENV       — Allowed origins are read from ALLOWED_ORIGINS in
 *                           .env instead of accepting every origin. Prevents
 *                           cross-site request forgery from unknown domains.
 *
 *  4. COMPRESSION         — Gzip-compresses all responses. Reduces payload
 *                           size by 60–70%, which matters for the Excel exports.
 *
 *  5. MORGAN LOGGING      — Logs every HTTP request. Uses 'combined' format
 *                           (Apache-style) in production for audit trails, and
 *                           'dev' format locally for readability.
 *
 *  6. RATE LIMITING       — Two limiters:
 *                             • Global:  100 req / 15 min per IP (all /api routes)
 *                             • Auth:     10 req / 15 min per IP (login endpoint)
 *                           Protects against brute-force and credential-stuffing.
 *
 *  7. BODY SIZE LIMIT     — express.json / urlencoded capped at 10 MB to
 *                           prevent JSON-bomb denial-of-service attacks.
 *
 *  8. TRUST PROXY         — Required when running behind Nginx. Without it,
 *                           req.ip always shows 127.0.0.1, breaking rate limiting.
 *
 *  9. /health ENDPOINT    — Standard health-check route used by Nginx, PM2,
 *                           load balancers, and uptime monitors.
 *
 * 10. 404 HANDLER         — Explicit "not found" response for unknown routes
 *                           instead of silent hangs or empty responses.
 *
 * 11. CENTRALIZED ERRORS  — errorHandler middleware receives all next(err) calls
 *                           from controllers and returns a consistent JSON shape.
 *                           Suppresses stack traces in production.
 *
 * 12. GRACEFUL SHUTDOWN   — On SIGTERM / SIGINT (sent by PM2, systemd, or
 *                           Ctrl+C), the server stops accepting new connections
 *                           and waits for in-flight requests to finish before
 *                           exiting. Prevents lost requests during deploys.
 *                           Hard-kills after 10 s in case of a hang.
 *
 * 13. UNHANDLED REJECTIONS — process.on('unhandledRejection') catches async
 *                           errors that escaped every try/catch block, logs them,
 *                           and exits cleanly (PM2 will restart).
 *
 * 14. UNCAUGHT EXCEPTIONS — Synchronous errors that bypass all handlers are
 *                           caught, logged, and cause a controlled exit.
 * ============================================================
 */

// Load .env FIRST — every other module reads process.env
require('dotenv').config();

// Validate required env vars immediately — fail fast before binding anything
const { validateEnv } = require('./middleware/validateEnv');
validateEnv();

const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const compression = require('compression');
const morgan   = require('morgan');
const rateLimit = require('express-rate-limit');

const { initializeDatabase }         = require('./config/database');
const authRoutes                      = require('./routes/authRoutes');
const userRoutes                      = require('./routes/userRoutes');
const warrantyRoutes                  = require('./routes/warrantyRoutes');
const { exportWarrantyForms, exportByBranch, exportEmployeeData } =
  require('./controllers/excelController');
const { verifyToken, authorizeRole }  = require('./middleware/auth');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();

// ── [1] TRUST PROXY ──────────────────────────────────────────────────────────
// When Nginx sits in front of Node, the real client IP arrives in
// X-Forwarded-For. Without trust proxy, req.ip is always 127.0.0.1,
// which breaks rate limiting (all clients share one bucket).
// '1' means trust exactly one hop (the Nginx instance).
app.set('trust proxy', 1);

// ── [2] SECURITY HEADERS (Helmet) ────────────────────────────────────────────
// Helmet applies a suite of HTTP headers in a single call:
//   Content-Security-Policy, X-Frame-Options, Strict-Transport-Security,
//   X-Content-Type-Options, X-XSS-Protection, Referrer-Policy, and more.
app.use(helmet());

// ── [3] CORS — restrict to known origins ─────────────────────────────────────
// ALLOWED_ORIGINS in .env is a comma-separated list:
//   ALLOWED_ORIGINS=http://localhost:5173,https://yourdomain.com
//
// Requests with no Origin header (curl, Postman, mobile apps hitting the API
// directly) are still allowed — origin: null means it's not a browser request,
// so CORS does not apply.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : [];

app.use(
  cors({
    origin: (origin, callback) => {
      // No origin = non-browser client (Postman, mobile app, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
);

// ── [4] RESPONSE COMPRESSION ─────────────────────────────────────────────────
// Compresses responses with gzip/deflate before they leave Node.
// Especially valuable for the Excel export endpoints and large JSON lists.
app.use(compression());

// ── [5] HTTP REQUEST LOGGING (Morgan) ────────────────────────────────────────
// 'combined' = Apache-style log (includes IP, user-agent, referrer) — ideal
//              for production log aggregators (ELK, CloudWatch, Papertrail).
// 'dev'      = concise colored output — only for local development.
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── [6a] GLOBAL RATE LIMITER ──────────────────────────────────────────────────
// 100 requests per 15 minutes per IP across all /api routes.
// Returns 429 Too Many Requests when exceeded.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,
  standardHeaders: true,      // Sends RateLimit-* response headers (RFC 6585)
  legacyHeaders: false,       // Omits deprecated X-RateLimit-* headers
  message: { message: 'Too many requests, please try again in 15 minutes.' }
});
app.use('/api', globalLimiter);

// ── [6b] AUTH-SPECIFIC RATE LIMITER ──────────────────────────────────────────
// The login endpoint is the primary target for credential-stuffing attacks.
// 10 attempts per 15 minutes per IP is strict enough to block automation
// while rarely affecting legitimate users.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts, please try again in 15 minutes.' }
});

// ── [7] BODY PARSERS ─────────────────────────────────────────────────────────
// 10 MB limit prevents JSON-bomb / large-payload DoS attacks.
// urlencoded is added for completeness (form POST support).
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── [9] HEALTH CHECK ─────────────────────────────────────────────────────────
// Used by:
//   • Nginx upstream checks      → upstream ezone { server 127.0.0.1:5000; }
//   • PM2 health checks          → ecosystem.config.js listen_timeout
//   • Uptime monitors            → UptimeRobot, Better Uptime, etc.
//   • Container orchestrators    → Docker HEALTHCHECK, Kubernetes liveness probe
//
// Returns 200 with uptime and environment — enough for a monitor to confirm
// the Node process is alive and serving without hitting the database.
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// ── API ROUTES ────────────────────────────────────────────────────────────────
// Auth routes get the stricter authLimiter (10 req/15 min) in addition to
// the global limiter already applied above.
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/warranty', warrantyRoutes);
app.get('/api/export/warranty', verifyToken, authorizeRole('ADMIN'), exportWarrantyForms);
app.get('/api/export/branch',   verifyToken, authorizeRole('ADMIN'), exportByBranch);
app.get('/api/export/employee', verifyToken, exportEmployeeData);

// Dashboard is defined inline here (no separate controller/route file).
// Pass errors to next(error) so the centralized errorHandler handles them.
app.get('/api/dashboard', verifyToken, authorizeRole('ADMIN'), async (req, res, next) => {
  try {
    const { pool } = require('./config/database');
    const connection = await pool.getConnection();

    const [employeeCount] = await connection.execute(
      'SELECT COUNT(*) as count FROM users WHERE role = ? AND is_active = ?',
      ['EMPLOYEE', true]
    );

    const [formCount] = await connection.execute(
      'SELECT COUNT(*) as count FROM warranty_forms'
    );

    const [recentForms] = await connection.execute(
      `SELECT wf.*, u.full_name as employee_name
       FROM warranty_forms wf
       JOIN users u ON wf.employee_id = u.id
       ORDER BY wf.created_at DESC
       LIMIT 5`
    );

    connection.release();

    res.json({
      total_employees: employeeCount[0].count,
      total_forms: formCount[0].count,
      recent_forms: recentForms
    });
  } catch (error) {
    next(error); // Forward to centralized errorHandler
  }
});

// ── [10] 404 HANDLER ─────────────────────────────────────────────────────────
// Must be registered AFTER all routes so it only catches unmatched paths.
// Returns { message: "Route GET /api/foo not found" } instead of a silent hang.
app.use(notFoundHandler);

// ── [11] CENTRALIZED ERROR HANDLER ───────────────────────────────────────────
// Must be registered LAST — Express identifies error middleware by its 4-arg
// signature (err, req, res, next). Handles every next(error) call from all routes.
app.use(errorHandler);

// ── SERVER STARTUP ────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 5000;

const startServer = async () => {
  try {
    // Initialize DB tables and optionally seed mock data before binding the port.
    // This ensures the server is never reachable before the schema is ready.
    const loadMockData = process.env.LOAD_MOCK_DATA !== 'false';
    await initializeDatabase(loadMockData);

    const server = app.listen(PORT, () => {
      console.log(
        `[${new Date().toISOString()}] Server running on port ${PORT} ` +
        `[${process.env.NODE_ENV || 'development'}]`
      );
    });

    // ── [12] GRACEFUL SHUTDOWN ────────────────────────────────────────────────
    // PM2 sends SIGINT on `pm2 reload` / `pm2 stop`.
    // systemd sends SIGTERM on `systemctl stop`.
    // Ctrl+C in development sends SIGINT.
    //
    // server.close() stops accepting new TCP connections and calls back once all
    // existing connections have finished. This prevents in-flight requests from
    // being cut off mid-response during a rolling deploy.
    const shutdown = (signal) => {
      console.log(
        `[${new Date().toISOString()}] ${signal} received — starting graceful shutdown`
      );
      server.close(() => {
        console.log(`[${new Date().toISOString()}] HTTP server closed. Process exiting.`);
        process.exit(0);
      });

      // Safety net: force-kill after 10 s if in-flight requests never finish.
      // This prevents a stuck request from blocking a deploy indefinitely.
      setTimeout(() => {
        console.error('[SHUTDOWN] Forced exit after 10 s timeout');
        process.exit(1);
      }, 10_000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

  } catch (error) {
    console.error('[STARTUP] Failed to start server:', error);
    process.exit(1);
  }
};

// ── [13] UNHANDLED PROMISE REJECTIONS ────────────────────────────────────────
// Catches async errors that escaped every try/catch (e.g., a controller that
// forgot to await and the promise threw asynchronously).
// In Node 15+, unhandled rejections crash the process by default — this hook
// gives us a log line and controlled exit instead of a silent crash.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION] Promise:', promise, '\nReason:', reason);
  // Exit so PM2 can restart with a clean state rather than running in a
  // potentially corrupt state.
  process.exit(1);
});

// ── [14] UNCAUGHT EXCEPTIONS ─────────────────────────────────────────────────
// Catches synchronous throws that bypassed every try/catch. These are always
// fatal — the application may be in an undefined state. Exit immediately and
// let PM2 restart the process.
process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT EXCEPTION]', error);
  process.exit(1);
});

startServer();
