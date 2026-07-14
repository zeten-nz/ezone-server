const { pool } = require('../config/database');
const { validationResult } = require('express-validator');
const productService = require('../services/productService');
const { EQUIPMENT_TYPE_TO_CATEGORIES } = require('../config/equipmentCategories');

const getAllProducts = async (req, res, next) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit    = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search   = (req.query.search || '').trim();
    const category = (req.query.category || '').trim();

    const connection = await pool.getConnection();
    const { rows, total } = await productService.findAllPaginated(connection, { page, limit, search, category });
    connection.release();

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
  }
};

/**
 * Powers the warranty form's Google-autocomplete-style product picker.
 * Available to any authenticated role (installers search mid-form-fill, not
 * just admins) — registered before the ADMIN gate in productRoutes.js.
 * `equipmentType` scopes results to that row's allowed categories (see
 * config/equipmentCategories.js) so, e.g., a reducer can't be attached to
 * the injector-rail slot. `brand` scopes to the installer's chosen Brand
 * (the Product field is disabled until one is picked). `fuelType` excludes
 * products whose own catalog fuel type conflicts with the warranty's single
 * installation-wide fuel type.
 */
const searchProducts = async (req, res, next) => {
  try {
    const query = (req.query.q || '').trim();
    const equipmentType = (req.query.equipmentType || '').trim();
    const brand = (req.query.brand || '').trim();
    const fuelType = (req.query.fuelType || '').trim();
    const categories = EQUIPMENT_TYPE_TO_CATEGORIES[equipmentType] || null;

    const connection = await pool.getConnection();
    const results = await productService.search(connection, { query, categories, brand: brand || null, fuelType: fuelType || null, limit: 20 });
    connection.release();

    res.json(results);
  } catch (error) {
    next(error);
  }
};

/**
 * Distinct Brand list for a given equipment slot — populates the Brand
 * `Select` that gates the Product autocomplete. Same any-authenticated-role
 * access as searchProducts.
 */
const getBrands = async (req, res, next) => {
  try {
    const equipmentType = (req.query.equipmentType || '').trim();
    const categories = EQUIPMENT_TYPE_TO_CATEGORIES[equipmentType] || null;

    const connection = await pool.getConnection();
    const brands = await productService.getDistinctBrands(connection, categories);
    connection.release();

    res.json(brands);
  } catch (error) {
    next(error);
  }
};

const createProduct = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const connection = await pool.getConnection();
    await productService.create(connection, req.body);
    connection.release();

    res.status(201).json({ message: 'Product created successfully' });
  } catch (error) {
    next(error);
  }
};

const updateProduct = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { productId } = req.params;
    const connection = await pool.getConnection();
    await productService.update(connection, productId, req.body);
    connection.release();

    res.json({ message: 'Product updated successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * Activates/deactivates a catalog entry — replaces the old IN_STOCK/
 * INSTALLED/RETIRED lifecycle, which no longer applies now that products
 * are a reusable catalog rather than serialized inventory. A deactivated
 * product simply stops appearing in search; it's never force-removed from
 * history (see deleteProduct below for the one real removal path).
 */
const setProductActive = (isActive) => async (req, res, next) => {
  try {
    const { productId } = req.params;
    const connection = await pool.getConnection();
    await productService.setActive(connection, productId, isActive);
    connection.release();

    res.json({ message: isActive ? 'Product activated successfully' : 'Product deactivated successfully' });
  } catch (error) {
    next(error);
  }
};

/**
 * Hard-deletes a catalog entry never referenced by any warranty — relies on
 * products.id's real FK (ON DELETE RESTRICT from warranty_equipment) as the
 * single source of truth for "is this in use," rather than duplicating that
 * check in application code the way the old status==='INSTALLED' guard did.
 */
const deleteProduct = async (req, res, next) => {
  const { productId } = req.params;
  let connection;
  try {
    connection = await pool.getConnection();
    const [result] = await connection.execute('DELETE FROM products WHERE id = ?', [productId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Product not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    if (error.errno === 1451) {
      return res.status(409).json({
        success: false,
        message: 'This product is referenced by existing warranties and cannot be deleted — deactivate it instead',
        errorCode: 'PRODUCT_IN_USE',
        timestamp: new Date().toISOString(),
      });
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getAllProducts,
  searchProducts,
  getBrands,
  createProduct,
  updateProduct,
  activateProduct: setProductActive(true),
  deactivateProduct: setProductActive(false),
  deleteProduct,
};
