const multer = require('multer');
const { validationResult } = require('express-validator');
const { pool } = require('../config/database');
const AppError = require('../utils/AppError');
const inventoryService = require('../services/inventoryService');
const inventoryRepository = require('../repositories/inventoryRepository');
const inventoryImportBatchRepository = require('../repositories/inventoryImportBatchRepository');
const productRepository = require('../repositories/productRepository');

const sendAppError = (res, error) => {
  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    errorCode: error.errorCode,
    timestamp: new Date().toISOString(),
  });
};

// In-memory storage — the raw CSV never needs to be persisted to disk, only
// parsed once and discarded; unlike config/uploads.js's photo pipeline
// (disk storage + magic-byte image verification), neither applies here.
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const importInventory = async (req, res, next) => {
  let connection;
  try {
    const { productId, branchId } = req.body;
    if (!productId || !req.file) {
      return res.status(400).json({
        success: false,
        message: 'productId and a CSV file are required',
        errorCode: 'VALIDATION_ERROR',
        timestamp: new Date().toISOString(),
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();
    try {
      const result = await inventoryService.importCsv(connection, {
        productId: parseInt(productId, 10),
        buffer: req.file.buffer,
        uploadedBy: req.user.id,
        fileName: req.file.originalname,
        branchId: branchId ? parseInt(branchId, 10) : null,
      });
      await connection.commit();
      res.status(201).json(result);
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Read-only, instant-feedback endpoint — any authenticated role, since
 * installers need it mid-form-fill (see routes/inventoryRoutes.js for why
 * this one is registered before the admin gate). Shares the exact same
 * validation rules as the authoritative server-side check inside
 * warrantyService.resolveEquipment (both call inventoryService.validateBarcode)
 * — this endpoint never claims anything, it only reports whether a claim
 * would currently succeed.
 */
const validateBarcode = async (req, res, next) => {
  let connection;
  try {
    const { barcode } = req.params;
    const { productId, equipmentType } = req.query;
    if (!productId) {
      return res.status(400).json({ success: false, message: 'productId is required', errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    const product = await productRepository.findById(connection, productId);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found', errorCode: 'PRODUCT_NOT_FOUND', timestamp: new Date().toISOString() });
    }

    const item = await inventoryService.validateBarcode(connection, { barcode, product, equipmentType });
    res.json({ id: item.id, barcode: item.barcode, product: { id: product.id, brand: product.brand, model: product.model, category: product.category } });
  } catch (error) {
    if (error instanceof AppError) {
      return sendAppError(res, error);
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const getInventory = async (req, res, next) => {
  let connection;
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const {
      productId, status, search,
      installerId, branchId, importBatchId,
      installedFrom, installedTo, claimedFrom, claimedTo,
    } = req.query;

    connection = await pool.getConnection();
    const { rows, total } = await inventoryRepository.findAllPaginated(connection, {
      page, limit, productId, status, search,
      installerId, branchId, importBatchId, installedFrom, installedTo, claimedFrom, claimedTo,
    });

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

const getImportBatches = async (req, res, next) => {
  let connection;
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    connection = await pool.getConnection();
    const { rows, total } = await inventoryImportBatchRepository.findAllPaginated(connection, { page, limit });

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

const getImportBatchDetail = async (req, res, next) => {
  let connection;
  try {
    const { batchId } = req.params;
    connection = await pool.getConnection();
    const batch = await inventoryImportBatchRepository.findById(connection, batchId);

    if (!batch) {
      return res.status(404).json({ success: false, message: 'Import batch not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }
    res.json(batch);
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

// Shared shape for the 4 manual operations below: open a transaction, run
// the service function (already validates + atomically guards + audit-logs
// internally), commit, translate AppError into the standard error response.
// Every one of these requires `reason` in the body — enforced by
// inventoryRoutes.js's express-validator rules, not re-checked here.
const runManualOperation = (serviceFn, buildArgs) => async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();
    try {
      await serviceFn(connection, buildArgs(req));
      await connection.commit();
      res.json({ message: 'Operation completed successfully' });
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } catch (error) {
    if (error instanceof AppError) {
      return sendAppError(res, error);
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const changeStatusManually = runManualOperation(inventoryService.changeStatusManually, (req) => ({
  itemId: req.params.itemId,
  fromStatus: req.body.fromStatus,
  toStatus: req.body.toStatus,
  reason: req.body.reason,
  changedBy: req.user.id,
}));

const transferBranch = runManualOperation(inventoryService.transferBranch, (req) => ({
  itemId: req.params.itemId,
  newBranchId: req.body.branchId || null,
  reason: req.body.reason,
  changedBy: req.user.id,
}));

const correctBarcode = runManualOperation(inventoryService.correctBarcode, (req) => ({
  itemId: req.params.itemId,
  newBarcode: req.body.newBarcode,
  reason: req.body.reason,
  changedBy: req.user.id,
}));

const mergeDuplicate = runManualOperation(inventoryService.mergeDuplicate, (req) => ({
  duplicateItemId: req.params.itemId,
  canonicalItemId: req.body.canonicalItemId,
  reason: req.body.reason,
  changedBy: req.user.id,
}));

module.exports = {
  csvUpload,
  importInventory,
  getInventory,
  getImportBatches,
  getImportBatchDetail,
  validateBarcode,
  changeStatusManually,
  transferBranch,
  correctBarcode,
  mergeDuplicate,
};
