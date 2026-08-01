const productRepository = require('../repositories/productRepository');

/**
 * Public product-catalog interface consumed by controllers and
 * warrantyService. Thin pass-through to productRepository — kept as its own
 * layer so callers depend on a stable interface (search/findById/create/
 * update/setActive) rather than the repository directly.
 */
const search = (connection, options) => productRepository.search(connection, options);
const getDistinctBrands = (connection, categories) => productRepository.getDistinctBrands(connection, categories);
const findById = (connection, productId) => productRepository.findById(connection, productId);
const findAllPaginated = (connection, options) => productRepository.findAllPaginated(connection, options);
const create = (connection, data) => productRepository.create(connection, data);
const update = (connection, productId, data) => productRepository.update(connection, productId, data);
const setActive = (connection, productId, isActive) => productRepository.setActive(connection, productId, isActive);

module.exports = { search, getDistinctBrands, findById, findAllPaginated, create, update, setActive };
