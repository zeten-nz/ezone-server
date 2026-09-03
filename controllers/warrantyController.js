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
const { toWarrantyResponse, toWarrantyListResponse, toWarrantyLookupResponse } = require('../dtos/warrantyDTO');
const { verifyImageMagicBytes, MANUAL_VERIFICATION_UPLOAD_DIR } = require('../config/uploads');
const { normalizePhone } = require('../utils/phoneFormat');

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
    // Release the create connection BEFORE the external EasyGas HTTP call — the create transaction is already
    // committed, and no DB connection/lock may be held for the duration of a network request (up to 15s).
    connection.release();
    connection = null;

    // Auto-submit to EasyGas immediately after creation — admin approval is gone. ONLY the request that actually
    // created the warranty submits (an idempotent submission_uuid retry returns created:false and must NOT trigger a
    // second EasyGas POST). syncWarrantyForm records the remote outcome on the row (easygas_sync_result SUCCESS/FAILED)
    // and never rolls back the committed warranty; wrap defensively so the create response always succeeds regardless.
    if (result.created) {
      try {
        await warrantyService.submitWarrantyToEasyGas(result.formId);
      } catch (syncError) {
        console.error(`[Warranty] EasyGas submission error for form ${result.formId}:`, syncError.message);
      }
    }

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
 * Warranty status workflow — admin review of the warranty form itself, a
 * separate concept from approveManualVerification/rejectManualVerification
 * above (which review one equipment row's barcode identity). Same shape:
 * read the service's typed AppError and translate it, never a raw 500.
 *
 * Awaits the FULL service call — including the EasyGas sync it triggers on
 * SUCCESSFUL — before releasing the connection in `finally`, even though
 * the sync itself acquires its own separate connection internally (see
 * easyGasWarrantySyncService.syncWarrantyForm). This request's response
 * only returns once sync has been attempted and its outcome recorded, so
 * the admin sees the real result immediately rather than a status that
 * might still change moments later.
 */
const approveWarrantyForm = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }
    const { formId } = req.params;
    connection = await pool.getConnection();
    await warrantyService.reviewWarrantyForm(connection, formId, req.user.id, {
      decision: 'SUCCESSFUL',
      notes: req.body.notes,
    });
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

const rejectWarrantyForm = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }
    const { formId } = req.params;
    connection = await pool.getConnection();
    await warrantyService.reviewWarrantyForm(connection, formId, req.user.id, {
      decision: 'REJECTED',
      notes: req.body.notes,
    });
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
  let connection;
  try {
    const { equipmentId } = req.params;
    connection = await pool.getConnection();
    const equipmentRow = await equipmentRepository.findById(connection, equipmentId);

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
  } finally {
    // Only the findById SELECT needs the connection — released here (right
    // after pipe() is wired up), never held for the file stream itself.
    if (connection) connection.release();
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
  let connection;
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

    connection = await pool.getConnection();
    const { rows, total } = await warrantyRepository.findAllPaginated(connection, { limit, offset, search, employeeId, verificationStatus });
    const forms = await attachEquipment(connection, rows);

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
  } finally {
    if (connection) connection.release();
  }
};

const getWarrantyFormDetail = async (req, res, next) => {
  let connection;
  try {
    const { formId } = req.params;
    connection = await pool.getConnection();

    const form = await warrantyRepository.findDetailById(connection, formId);
    if (!form) {
      return res.status(404).json({ success: false, message: 'Warranty form not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    const [withEquipment] = await attachEquipment(connection, [form]);

    res.json(toWarrantyResponse(withEquipment));
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const searchWarrantyForms = async (req, res, next) => {
  let connection;
  try {
    const { search, filterType } = req.query;
    connection = await pool.getConnection();

    const rows = await warrantyRepository.searchForms(connection, { search, filterType });
    const forms = await attachEquipment(connection, rows);

    res.json(toWarrantyListResponse(forms));
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Authenticated customer lookup by phone (Beta-1) — the service-technician
 * workflow: a customer returns months later, the technician enters their
 * phone number and sees every warranty registered to it (vehicle, installed
 * equipment + serials, installation date, installer/branch).
 *
 * Authorization: verifyToken only — BOTH roles (EMPLOYEE and ADMIN) may
 * look up ANY customer's warranties, deliberately NOT scoped to
 * req.user.id or the requester's branch: a customer can return to a
 * different technician/branch and must still be identifiable.
 * Authentication is the access boundary (the old unauthenticated
 * POST /api/public/customer/warranties was retired in this same change).
 *
 * Phone comparison reuses the project's ONE normalization
 * (utils/phoneFormat.normalizePhone → 9-digit national key) and the ONE
 * repository comparison (findByOwnerPhone's parameterized
 * RIGHT(REGEXP_REPLACE(...), 9) = ?) — no second implementation, no LIKE,
 * no fuzzy search. Input that doesn't reduce to a full 9-digit key is
 * rejected before any query runs. The response is the SAFE allowlisted
 * lookup DTO (see toWarrantyLookupResponse) — never the full admin shape.
 * Equipment is attached with ONE batched query for the whole result set
 * (attachEquipment), never per warranty. The raw phone is not logged.
 */
const lookupWarrantiesByPhone = async (req, res, next) => {
  let connection;
  try {
    const phone = normalizePhone(req.query.phone);
    if (!phone || phone.length !== 9) {
      return res.status(400).json({ success: false, message: 'A valid phone number is required', errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    const rows = await warrantyRepository.findByOwnerPhone(connection, phone); // newest first (ORDER BY created_at DESC)
    const forms = await attachEquipment(connection, rows);

    res.json(toWarrantyLookupResponse(forms));
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const getMyWarrantyForms = async (req, res, next) => {
  let connection;
  try {
    // Always use the authenticated user's ID — never accept employeeId from query params.
    const employeeId = req.user.id;
    const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = (req.query.search || '').trim();
    const offset = (page - 1) * limit;

    connection = await pool.getConnection();
    const { rows, total } = await warrantyRepository.findMinePaginated(connection, employeeId, { limit, offset, search });
    const forms = await attachEquipment(connection, rows);

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
  } finally {
    if (connection) connection.release();
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
  lookupWarrantiesByPhone,
  approveManualVerification,
  rejectManualVerification,
  approveWarrantyForm,
  rejectWarrantyForm,
  uploadEquipmentPhoto,
  streamEquipmentPhoto,
};
