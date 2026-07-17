const { pool } = require('../config/database');
const { validationResult } = require('express-validator');
const AppError = require('../utils/AppError');
const pointsService = require('../services/pointsService');

const sendAppError = (res, error) => {
  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    errorCode: error.errorCode,
    timestamp: new Date().toISOString(),
  });
};

const paginationParams = (req) => ({
  page: Math.max(1, parseInt(req.query.page, 10) || 1),
  limit: Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20)),
});

// Always the authenticated user's own id — never accept installerId from
// query params, same pattern as warrantyController.getMyWarrantyForms.
const getMyPoints = async (req, res, next) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const { rows, total, installerTotal } = await pointsService.getInstallerLedger(connection, req.user.id, paginationParams(req));
    const { page, limit } = paginationParams(req);
    const totalPages = Math.ceil(total / limit);
    res.json({
      total: installerTotal,
      data: rows,
      pagination: { page, limit, totalItems: total, totalPages, hasNext: page < totalPages, hasPrevious: page > 1 },
    });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

// ADMIN — any installer's ledger + total.
const getInstallerPoints = async (req, res, next) => {
  let connection;
  try {
    const { installerId } = req.params;
    connection = await pool.getConnection();
    const { rows, total, installerTotal } = await pointsService.getInstallerLedger(connection, installerId, paginationParams(req));
    const { page, limit } = paginationParams(req);
    const totalPages = Math.ceil(total / limit);
    res.json({
      total: installerTotal,
      data: rows,
      pagination: { page, limit, totalItems: total, totalPages, hasNext: page < totalPages, hasPrevious: page > 1 },
    });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

// ADMIN (view) — products with their current configured point value, for
// the admin config grid.
const getProductConfigs = async (req, res, next) => {
  let connection;
  try {
    const { search } = req.query;
    connection = await pool.getConnection();
    const { rows, total } = await pointsService.listProductConfigs(connection, { ...paginationParams(req), search });
    const { page, limit } = paginationParams(req);
    const totalPages = Math.ceil(total / limit);
    res.json({
      data: rows,
      pagination: { page, limit, totalItems: total, totalPages, hasNext: page < totalPages, hasPrevious: page > 1 },
    });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

// Super Admin only — sets a product's current point value going forward;
// never touches already-awarded points (those are frozen onto their own
// ledger rows).
const setProductConfig = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { productId } = req.params;
    const { points } = req.body;
    connection = await pool.getConnection();
    await pointsService.setProductConfig(connection, { productId, points, updatedBy: req.user.id });
    res.json({ message: 'Point value updated successfully' });
  } catch (error) {
    if (error instanceof AppError) {
      return sendAppError(res, error);
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

// Super Admin only — manual bonus/penalty/adjustment.
const createAdjustment = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { installerId, points, type, reason, idempotencyKey } = req.body;
    connection = await pool.getConnection();
    const transaction = await pointsService.createManualTransaction(connection, {
      installerId,
      points,
      transactionType: type,
      reason,
      idempotencyKey,
      createdBy: req.user.id,
    });
    res.status(201).json(transaction);
  } catch (error) {
    if (error instanceof AppError) {
      return sendAppError(res, error);
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getMyPoints,
  getInstallerPoints,
  getProductConfigs,
  setProductConfig,
  createAdjustment,
};
