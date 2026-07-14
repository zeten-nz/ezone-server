/**
 * Generic application error carrying an HTTP status + bilingual-lookup
 * errorCode (see ezone/src/config/errorCodes.js on the frontend). Thrown by
 * services for expected business-rule violations (missing branch, invalid
 * equipment selection, ownership/edit-window checks, etc.) and caught by
 * controllers to build the direct { success:false, message, errorCode }
 * response — anything else falls through to next(error) and the
 * centralized errorHandler.
 */
class AppError extends Error {
  constructor(message, statusCode, errorCode) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

module.exports = AppError;
