const { pool } = require('../config/database');
const carRepository = require('../repositories/carRepository');

/**
 * Powers the warranty form's Vehicle Name catalog-first-with-free-text-
 * fallback autocomplete. Available to any authenticated role, same as
 * productController.searchProducts — installers search mid-form-fill.
 */
const searchCars = async (req, res, next) => {
  try {
    const query = (req.query.q || '').trim();
    if (!query) {
      return res.json([]);
    }
    const connection = await pool.getConnection();
    const results = await carRepository.search(connection, { query, limit: 20 });
    connection.release();
    res.json(results);
  } catch (error) {
    next(error);
  }
};

module.exports = { searchCars };
