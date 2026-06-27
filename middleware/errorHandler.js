/**
 * CENTRALIZED ERROR HANDLER
 *
 * All controllers use next(error) to forward errors here instead of
 * writing res.status(500).json() in every catch block. This gives us:
 *   - One place to control the error response format across every endpoint
 *   - Stack traces suppressed in production so internals are never leaked
 *   - A single integration point for future error-monitoring services (Sentry, Datadog)
 *
 * Express identifies error-handling middleware by its 4-argument signature (err, req, res, next).
 * It MUST be registered after all routes in server.js.
 */

const errorHandler = (err, req, res, next) => {
  // Determine the HTTP status code to send back:
  //   - err.statusCode / err.status come from intentional throws (e.g. 400, 403, 404)
  //   - default to 500 for unexpected errors
  const statusCode = err.statusCode || err.status || 500;

  // Always log the full error server-side (including stack trace) for debugging
  console.error(
    `[${new Date().toISOString()}] ERROR ${statusCode} ${req.method} ${req.originalUrl} — ${err.message}`
  );
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

  // Never expose internal error messages or stack traces to clients in production.
  // Generic "Internal server error" for 500s; the real message for 4xx client errors.
  const clientMessage =
    statusCode >= 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message || 'Internal server error';

  res.status(statusCode).json({ message: clientMessage });
};

/**
 * 404 NOT FOUND HANDLER
 *
 * Catches every request that didn't match a registered route.
 * Must be placed after all routes but before errorHandler.
 */
const notFoundHandler = (req, res) => {
  res.status(404).json({
    message: `Route ${req.method} ${req.originalUrl} not found`
  });
};

module.exports = { errorHandler, notFoundHandler };
