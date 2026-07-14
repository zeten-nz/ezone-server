const { pool } = require('../config/database');
const { validationResult } = require('express-validator');
const AppError = require('../utils/AppError');
const warrantyService = require('../services/warrantyService');
const warrantyRepository = require('../repositories/warrantyRepository');
const { attachEquipment } = require('../utils/warrantyEquipment');
const { toWarrantyResponse, toWarrantyListResponse } = require('../dtos/warrantyDTO');

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
    const formId = await warrantyService.createWarrantyForm(connection, req.user.id, req.body);
    res.status(201).json({ message: 'Warranty form submitted successfully', id: formId });
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
 * missing product) — see warrantyRepository.resetSyncStatus.
 */
const retryWarrantySync = async (req, res, next) => {
  let connection;
  try {
    const { formId } = req.params;
    connection = await pool.getConnection();
    const reset = await warrantyRepository.resetSyncStatus(connection, formId);
    if (!reset) {
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

const deleteWarrantyForm = async (req, res, next) => {
  let connection;
  try {
    const { formId } = req.params;
    connection = await pool.getConnection();
    await warrantyService.deleteWarrantyForm(connection, formId);
    res.json({ message: 'Warranty form deleted successfully' });
  } catch (error) {
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
    const offset = (page - 1) * limit;

    const connection = await pool.getConnection();
    const { rows, total } = await warrantyRepository.findAllPaginated(connection, { limit, offset, search });
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
};
