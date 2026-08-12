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

  // ── EasyGas integration configuration ──────────────────────────────────
  // The warranty POST and catalog sync both sign with EASYGAS_SHARED_SECRET
  // against EASYGAS_WARRANTY_API_BASE_URL. A placeholder secret produces
  // invalid signatures against the real API, so in production a known-bad
  // EasyGas configuration is a hard startup failure (a live integration
  // silently signing everything wrong is worse than not starting). In
  // development it stays a warning — the EasyGas clients already degrade
  // gracefully (normalized failures, never throws), so local work without
  // real credentials remains possible. The secret's VALUE is never printed
  // here or anywhere else — only what kind of problem it has.
  const easyGasProblems = [];
  const easyGasSecret = process.env.EASYGAS_SHARED_SECRET;
  if (!easyGasSecret) {
    easyGasProblems.push('EASYGAS_SHARED_SECRET is missing');
  } else if (/CHANGE_ME|PLACEHOLDER|YOUR_SECRET|REPLACE/i.test(easyGasSecret)) {
    easyGasProblems.push('EASYGAS_SHARED_SECRET is still a placeholder value');
  }
  const easyGasUrl = process.env.EASYGAS_WARRANTY_API_BASE_URL;
  if (!easyGasUrl) {
    easyGasProblems.push('EASYGAS_WARRANTY_API_BASE_URL is missing');
  } else {
    try {
      new URL(easyGasUrl);
    } catch {
      easyGasProblems.push('EASYGAS_WARRANTY_API_BASE_URL is not a valid URL');
    }
  }
  if (easyGasProblems.length > 0) {
    if (process.env.NODE_ENV === 'production') {
      console.error(
        `[STARTUP ERROR] EasyGas configuration is invalid: ${easyGasProblems.join('; ')}.\n` +
        '[STARTUP ERROR] Refusing to start in production with a broken EasyGas integration — ' +
        'set the real values (obtained from EasyGas) in .env and restart.'
      );
      process.exit(1);
    }
    console.warn(
      `[STARTUP WARNING] EasyGas configuration is invalid: ${easyGasProblems.join('; ')}. ` +
      'EasyGas warranty submission and catalog sync will fail until this is fixed ' +
      '(fatal at startup when NODE_ENV=production).'
    );
  }

  console.log('[STARTUP] Environment variables validated successfully.');
};

module.exports = { validateEnv };
