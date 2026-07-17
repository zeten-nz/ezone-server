/**
 * ENVIRONMENT VARIABLE VALIDATOR
 *
 * Called once at process startup — before the HTTP server binds — to verify
 * that every variable the application depends on is actually present.
 *
 * "Fail fast" principle: it is far better to refuse to start with a clear
 * error message than to start and crash at runtime with a cryptic stack trace
 * when the first database query fires.
 */

// Variables that MUST be present for the application to function correctly
const REQUIRED_VARS = [
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'JWT_SECRET'
];

const validateEnv = () => {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(
      `[STARTUP ERROR] Missing required environment variables: ${missing.join(', ')}\n` +
      '[STARTUP ERROR] Copy .env.example to .env and fill in all required values.'
    );
    process.exit(1);
  }

  // ALLOWED_ORIGINS is only enforced in production. An empty/unset value
  // combined with credentials:true in server.js's CORS config would allow
  // every origin — acceptable for local development, never in production.
  // Parsed the same way server.js parses it, so "set but empty/whitespace"
  // (e.g. ALLOWED_ORIGINS=",  ,") is caught here too, not just "unset".
  if (process.env.NODE_ENV === 'production') {
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);

    if (allowedOrigins.length === 0) {
      console.error(
        '[STARTUP ERROR] ALLOWED_ORIGINS is required when NODE_ENV=production ' +
        '(comma-separated list of allowed frontend origins, e.g. ' +
        'https://ezone.yourdomain.com). Refusing to start with an open CORS ' +
        'policy — see .env.example.'
      );
      process.exit(1);
    }
  }

  // Warn loudly if someone ships to production with the placeholder JWT secret
  if (process.env.JWT_SECRET === 'your_jwt_secret_key_change_in_production') {
    console.warn(
      '[STARTUP WARNING] JWT_SECRET is still the default placeholder value. ' +
      'Generate a real secret before going to production:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"'
    );
  }

  console.log('[STARTUP] Environment variables validated successfully.');
};

module.exports = { validateEnv };
