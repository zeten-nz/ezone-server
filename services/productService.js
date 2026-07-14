const productRepository = require('../repositories/productRepository');

/**
 * Public product-catalog interface consumed by controllers and
 * warrantyService. Backed by our own catalog table for now (see
 * productRepository) — a future implementation backed by the real external
 * STAG product API can replace the body of these functions without any
 * caller needing to change, since this interface (search/findById/create/
 * update/setActive) stays the same either way.
 */
const search = (connection, options) => productRepository.search(connection, options);
const getDistinctBrands = (connection, categories) => productRepository.getDistinctBrands(connection, categories);
const findById = (connection, productId) => productRepository.findById(connection, productId);
const findAllPaginated = (connection, options) => productRepository.findAllPaginated(connection, options);
const create = (connection, data) => productRepository.create(connection, data);
const update = (connection, productId, data) => productRepository.update(connection, productId, data);
const setActive = (connection, productId, isActive) => productRepository.setActive(connection, productId, isActive);

module.exports = { search, getDistinctBrands, findById, findAllPaginated, create, update, setActive };
