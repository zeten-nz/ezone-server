const { pool } = require('../config/database');
const { validationResult } = require('express-validator');
const brandRepository = require('../repositories/brandRepository');

const getAllBrands = async (req, res, next) => {
  let connection;
  try {
    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = (req.query.search || '').trim();

    connection = await pool.getConnection();
    const { rows, total } = await brandRepository.findAllPaginated(connection, { page, limit, search });

    const totalPages = Math.ceil(total / limit);
    res.json({
      data: rows,
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

/** Active brands only — powers the Product form's Brand select. Any
 * authenticated role, same as productController.searchProducts. */
const getActiveBrands = async (req, res, next) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const brands = await brandRepository.findAllActive(connection);
    res.json(brands);
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const createBrand = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    await brandRepository.create(connection, req.body);

    res.status(201).json({ message: 'Brand created successfully' });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const updateBrand = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { brandId } = req.params;
    connection = await pool.getConnection();
    await brandRepository.update(connection, brandId, req.body);

    res.json({ message: 'Brand updated successfully' });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

/** Activates/deactivates a brand — a deactivated brand simply stops
 * appearing in the Product form's Brand select; never force-removed from
 * history (see deleteBrand below for the one real removal path), same
 * convention as productController.setProductActive. */
const setBrandActive = (isActive) => async (req, res, next) => {
  let connection;
  try {
    const { brandId } = req.params;
    connection = await pool.getConnection();
    await brandRepository.setActive(connection, brandId, isActive);

    res.json({ message: isActive ? 'Brand activated successfully' : 'Brand deactivated successfully' });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

/** Hard-deletes a brand never referenced by any product — relies on
 * products.brand_id's real FK (ON DELETE RESTRICT) as the single source of
 * truth for "is this in use," same pattern as productController.deleteProduct. */
const deleteBrand = async (req, res, next) => {
  const { brandId } = req.params;
  let connection;
  try {
    connection = await pool.getConnection();
    const [result] = await connection.execute('DELETE FROM brands WHERE id = ?', [brandId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Brand not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }
    res.json({ message: 'Brand deleted successfully' });
  } catch (error) {
    if (error.errno === 1451) {
      return res.status(409).json({
        success: false,
        message: 'This brand is referenced by existing products and cannot be deleted — deactivate it instead',
        errorCode: 'BRAND_IN_USE',
        timestamp: new Date().toISOString(),
      });
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getAllBrands,
  getActiveBrands,
  createBrand,
  updateBrand,
  activateBrand: setBrandActive(true),
  deactivateBrand: setBrandActive(false),
  deleteBrand,
};
