const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');
const { validationResult } = require('express-validator');
const AppError = require('../utils/AppError');
const warrantyService = require('../services/warrantyService');
const warrantyRepository = require('../repositories/warrantyRepository');
const equipmentRepository = require('../repositories/equipmentRepository');
const manualVerificationUploadRepository = require('../repositories/manualVerificationUploadRepository');
const { attachEquipment } = require('../utils/warrantyEquipment');
const { toWarrantyResponse, toWarrantyListResponse } = require('../dtos/warrantyDTO');
const { verifyImageMagicBytes, MANUAL_VERIFICATION_UPLOAD_DIR } = require('../config/uploads');

const sendAppError = (res, error) => {
  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    errorCode: error.errorCode,
    timestamp: new Date().toISOString(),
  });
};

const createWarrantyForm = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    const result = await warrantyService.createWarrantyForm(connection, req.user.id, req.body);
    res.status(result.created ? 201 : 200).json({
      message: result.created ? 'Warranty form submitted successfully' : 'Warranty form already submitted',
      id: result.formId,
    });
  } catch (error) {
    if (error instanceof AppError) {
      return sendAppError(res, error);
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const updateWarrantyForm = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const formId = parseInt(req.params.formId, 10);
    connection = await pool.getConnection();

    await warrantyService.updateWarrantyForm(connection, formId, req.user.id, req.user.role, req.body);

    const updatedForm = await warrantyRepository.findDetailById(connection, formId);
    const [withEquipment] = await attachEquipment(connection, [updatedForm]);
    res.json(toWarrantyResponse(withEquipment));
  } catch (error) {
    if (error instanceof AppError) {
      return sendAppError(res, error);
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Manual admin retry for a warranty stuck in FAILED sync status — resets it
 * to PENDING so the next easyGasSyncSweep cycle picks it up again. Allowed
 * for terminal failures too (e.g. PRODUCT_NOT_MAPPED after an admin maps the
 * missing product) — see warrantyRepository.resetSyncStatus, which is the
 * actual enforcement point: it refuses the reset outright (regardless of
 * this or any future caller) while any equipment row is still PENDING or
 * REJECTED under Manual Verification. The extra lookup below only decides
 * which of two error messages to show — it grants no capability itself.
 */
const retryWarrantySync = async (req, res, next) => {
  let connection;
  try {
    const { formId } = req.params;
    connection = await pool.getConnection();
    const reset = await warrantyRepository.resetSyncStatus(connection, formId);
    if (!reset) {
      const blocked = await warrantyRepository.hasUnresolvedManualVerification(connection, formId);
      if (blocked) {
        return res.status(409).json({
          success: false,
          message: 'This warranty has an equipment item awaiting or rejected by Manual Verification — resolve it before retrying sync',
          errorCode: 'MANUAL_VERIFICATION_UNRESOLVED',
          timestamp: new Date().toISOString(),
        });
      }
      return res.status(409).json({
        success: false,
        message: 'Warranty is not currently in a FAILED sync state',
        errorCode: 'INVALID_STATE',
        timestamp: new Date().toISOString(),
      });
    }
    res.json({ message: 'Sync reset — will retry on the next sweep cycle' });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Manual Verification workflow — admin review actions, same shape as
 * registrationRequestController's approve/reject: read the service's typed
 * AppError (409 INVALID_STATE on a duplicate/already-reviewed request, 404
 * if the row or its warranty vanished) and translate it, never a raw 500.
 * `notes` is optional on both, matching rejectRegistrationRequest's own
 * convention (not required even to reject).
 */
const approveManualVerification = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }
    const { equipmentId } = req.params;
    connection = await pool.getConnection();
    await warrantyService.reviewManualVerification(connection, equipmentId, req.user.id, {
      decision: 'APPROVED',
      notes: req.body.notes,
    });
    res.json({ message: 'Manual verification approved' });
  } catch (error) {
    if (error instanceof AppError) {
      return sendAppError(res, error);
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const rejectManualVerification = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }
    const { equipmentId } = req.params;
    connection = await pool.getConnection();
    await warrantyService.reviewManualVerification(connection, equipmentId, req.user.id, {
      decision: 'REJECTED',
      notes: req.body.notes,
    });
    res.json({ message: 'Manual verification rejected' });
  } catch (error) {
    if (error instanceof AppError) {
      return sendAppError(res, error);
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Pre-upload endpoint for a Manual Verification equipment photo — installer-
 * authenticated (any role, not ADMIN-gated; see routes), multipart, one
 * file. Deliberately decoupled from the warranty create/update JSON body,
 * same pattern authController.updateProfilePhoto already uses for its own
 * upload: the file lands on disk (random filename, magic-byte verified)
 * through its own small request, and the returned filename then travels as
 * a plain string field inside the ordinary warranty submission — no reason
 * to convert that endpoint's express-validator JSON body handling to
 * multipart just to carry up to 4 conditional files.
 *
 * Records who uploaded it (manualVerificationUploadRepository) so a later
 * warranty submission can't attach a filename it didn't actually upload —
 * see inventoryService.resolveOwnedPhotoFilename, the function that
 * actually enforces this. A bare returned filename string was never itself
 * a capability; it's just a name until ownership is checked at submission
 * time.
 */
const uploadEquipmentPhoto = async (req, res, next) => {
  let connection;
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Photo is required', errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }
    if (!verifyImageMagicBytes(req.file.path)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ success: false, message: 'File is not a valid image', errorCode: 'INVALID_FILE_TYPE', timestamp: new Date().toISOString() });
    }
    connection = await pool.getConnection();
    await manualVerificationUploadRepository.create(connection, { filename: req.file.filename, uploadedBy: req.user.id });
    res.status(201).json({ filename: req.file.filename });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Streams a Manual Verification equipment photo back — ADMIN-only, same
 * authenticated-stream-never-express.static pattern as
 * registrationRequestController.streamRegistrationPhoto (a seller's photo is
 * PII, same class of concern as a registration applicant's photo).
 */
const streamEquipmentPhoto = async (req, res, next) => {
  try {
    const { equipmentId } = req.params;
    const connection = await pool.getConnection();
    const equipmentRow = await equipmentRepository.findById(connection, equipmentId);
    connection.release();

    if (!equipmentRow || !equipmentRow.manual_verification_photo_filename) {
      return res.status(404).json({ success: false, message: 'Photo not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    const { manual_verification_photo_filename: photoFilename } = equipmentRow;

    // Defense-in-depth: always server-generated (see config/uploads.js), but
    // guard against path traversal regardless, same as streamRegistrationPhoto.
    const safeName = path.basename(photoFilename);
    if (safeName !== photoFilename) {
      return res.status(400).json({ success: false, message: 'Invalid file reference', errorCode: 'INVALID_FILE', timestamp: new Date().toISOString() });
    }

    const filePath = path.join(MANUAL_VERIFICATION_UPLOAD_DIR, safeName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'Photo not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    const ext = path.extname(safeName).toLowerCase();
    const contentType = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, no-store');

    // .pipe() does not forward source-stream errors to the response — same
    // fix as streamRegistrationPhoto/authController.streamProfilePhoto.
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

const deleteWarrantyForm = async (req, res, next) => {
  let connection;
  try {
    const { formId } = req.params;
    connection = await pool.getConnection();
    await warrantyService.deleteWarrantyForm(connection, formId, req.user.id);
    res.json({ message: 'Warranty form deleted successfully' });
  } catch (error) {
    if (error instanceof AppError) {
      return sendAppError(res, error);
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const getAllWarrantyForms = async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = (req.query.search || '').trim();
    // Optional installer drill-down (e.g. from Installer Statistics' "View
    // warranties" link) — scopes this same admin list to one employee's
    // warranties instead of a separate page/table.
    const employeeId = req.query.employeeId ? parseInt(req.query.employeeId, 10) : undefined;
    // Manual Verification workflow admin filter — e.g. ?verificationStatus=PENDING
    // shows only warranties with an equipment row still awaiting review.
    // Same optional-query-param pattern as employeeId above, not a separate
    // endpoint or list page.
    const verificationStatus = req.query.verificationStatus || undefined;
    const offset = (page - 1) * limit;

    const connection = await pool.getConnection();
    const { rows, total } = await warrantyRepository.findAllPaginated(connection, { limit, offset, search, employeeId, verificationStatus });
    const forms = await attachEquipment(connection, rows);
    connection.release();

    const totalPages = Math.ceil(total / limit);
    res.json({
      data: toWarrantyListResponse(forms),
      pagination: {
        page, limit, totalItems: total, totalPages,
        hasNext: page < totalPages,
        hasPrevious: page > 1,
      },
    });
  } catch (error) {
    next(error);
  }
};

const getWarrantyFormDetail = async (req, res, next) => {
  try {
    const { formId } = req.params;
    const connection = await pool.getConnection();

    const form = await warrantyRepository.findDetailById(connection, formId);
    if (!form) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Warranty form not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    const [withEquipment] = await attachEquipment(connection, [form]);
    connection.release();

    res.json(toWarrantyResponse(withEquipment));
  } catch (error) {
    next(error);
  }
};

const searchWarrantyForms = async (req, res, next) => {
  try {
    const { search, filterType } = req.query;
    const connection = await pool.getConnection();

    const rows = await warrantyRepository.searchForms(connection, { search, filterType });
    const forms = await attachEquipment(connection, rows);
    connection.release();

    res.json(toWarrantyListResponse(forms));
  } catch (error) {
    next(error);
  }
};

const getMyWarrantyForms = async (req, res, next) => {
  try {
    // Always use the authenticated user's ID — never accept employeeId from query params.
    const employeeId = req.user.id;
    const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = (req.query.search || '').trim();
    const offset = (page - 1) * limit;

    const connection = await pool.getConnection();
    const { rows, total } = await warrantyRepository.findMinePaginated(connection, employeeId, { limit, offset, search });
    const forms = await attachEquipment(connection, rows);
    connection.release();

    const totalPages = Math.ceil(total / limit);
    res.json({
      data: toWarrantyListResponse(forms),
      pagination: {
        page, limit, totalItems: total, totalPages,
        hasNext: page < totalPages,
        hasPrevious: page > 1,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createWarrantyForm,
  updateWarrantyForm,
  getAllWarrantyForms,
  getWarrantyFormDetail,
  deleteWarrantyForm,
  searchWarrantyForms,
  getMyWarrantyForms,
  retryWarrantySync,
  approveManualVerification,
  rejectManualVerification,
  uploadEquipmentPhoto,
  streamEquipmentPhoto,
};
