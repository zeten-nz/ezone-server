/**
 * CENTRALIZED ERROR HANDLER
 *
 * All unexpected errors flow here via next(error) from controllers.
 * Intentional 4xx responses (validation, not-found, permission checks)
 * are sent directly by controllers and do NOT pass through here.
 *
 * Guarantees:
 *   - Consistent error envelope on every error response
 *   - No MySQL errors, stack traces, or SQL leaks to clients
 *   - Full detail logged server-side for debugging
 *   - Single integration point for future monitoring (Sentry, Datadog)
 */

const HTTP_ERROR_CODES = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_SERVER_ERROR',
};

const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  const errorCode  = HTTP_ERROR_CODES[statusCode] || 'INTERNAL_SERVER_ERROR';

  console.error(
    `[${new Date().toISOString()}] ERROR ${statusCode} ${req.method} ${req.originalUrl} — ${err.message}`
  );
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

  // Never expose internal messages or MySQL errors on 5xx in production.
  const message =
    statusCode >= 500 && process.env.NODE_ENV === 'production'
      ? 'An unexpected server error occurred. Please try again later.'
      : err.message || 'An unexpected server error occurred. Please try again later.';

  res.status(statusCode).json({
    success:   false,
    message,
    errorCode,
    timestamp: new Date().toISOString(),
  });
};

/**
 * 404 NOT FOUND HANDLER
 * Catches any request that didn't match a registered route.
 * Registered after all routes but before errorHandler.
 */
const notFoundHandler = (req, res) => {
  res.status(404).json({
    success:   false,
    message:   `Route ${req.method} ${req.originalUrl} not found`,
    errorCode: 'NOT_FOUND',
    timestamp: new Date().toISOString(),
  });
};

module.exports = { errorHandler, notFoundHandler };
