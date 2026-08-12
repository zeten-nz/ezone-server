const { pool } = require('../config/database');
const { validationResult } = require('express-validator');
const carRepository = require('../repositories/carRepository');

const getAllCars = async (req, res, next) => {
  let connection;
  try {
    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = (req.query.search || '').trim();

    connection = await pool.getConnection();
    const { rows, total } = await carRepository.findAllPaginated(connection, { page, limit, search });

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

/**
 * Powers the warranty form's Vehicle Name catalog-first-with-free-text-
 * fallback autocomplete. Available to any authenticated role, same as
 * productController.searchProducts — installers search mid-form-fill.
 */
const searchCars = async (req, res, next) => {
  let connection;
  try {
    const query = (req.query.q || '').trim();
    if (!query) {
      return res.json([]);
    }
    connection = await pool.getConnection();
    const results = await carRepository.search(connection, { query, limit: 20 });
    res.json(results);
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const createCar = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    await carRepository.create(connection, req.body);

    res.status(201).json({ message: 'Car created successfully' });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

const updateCar = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { carId } = req.params;
    connection = await pool.getConnection();
    await carRepository.update(connection, carId, req.body);

    res.json({ message: 'Car updated successfully' });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

/** Activates/deactivates a car — a deactivated car simply stops appearing
 * in the Vehicle Name autocomplete; never force-removed from history (see
 * deleteCar below for the one real removal path). */
const setCarActive = (isActive) => async (req, res, next) => {
  let connection;
  try {
    const { carId } = req.params;
    connection = await pool.getConnection();
    await carRepository.setActive(connection, carId, isActive);

    res.json({ message: isActive ? 'Car activated successfully' : 'Car deactivated successfully' });
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

/** Hard-deletes a car never referenced by any warranty — relies on
 * warranty_forms.car_id's real FK (ON DELETE RESTRICT) as the single source
 * of truth for "is this in use," same pattern as productController.deleteProduct. */
const deleteCar = async (req, res, next) => {
  const { carId } = req.params;
  let connection;
  try {
    connection = await pool.getConnection();
    const [result] = await connection.execute('DELETE FROM cars WHERE id = ?', [carId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Car not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }
    res.json({ message: 'Car deleted successfully' });
  } catch (error) {
    if (error.errno === 1451) {
      return res.status(409).json({
        success: false,
        message: 'This car is referenced by existing warranties and cannot be deleted — deactivate it instead',
        errorCode: 'CAR_IN_USE',
        timestamp: new Date().toISOString(),
      });
    }
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

module.exports = {
  getAllCars,
  searchCars,
  createCar,
  updateCar,
  activateCar: setCarActive(true),
  deactivateCar: setCarActive(false),
  deleteCar,
};
