/**
 * All raw SQL for the products catalog. `products` rows are reusable models
 * (e.g. "STAG R02"), not serialized physical units — there is no consume/
 * release lifecycle here anymore, just a searchable, admin-managed catalog.
 */

const findAllPaginated = async (connection, { page, limit, search, category }) => {
  const offset = (page - 1) * limit;
  const conditions = [];
  const params = [];
  if (search) {
    conditions.push('(brand LIKE ? OR model LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countRows] = await connection.execute(`SELECT COUNT(*) AS total FROM products ${whereClause}`, params);
  const [rows] = await connection.execute(
    `SELECT * FROM products ${whereClause} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return { rows, total: countRows[0].total };
};

/** Powers the warranty form's Google-autocomplete-style product search —
 * only ever returns active catalog rows, scoped to the equipment slot's
 * allowed categories (see config/equipmentCategories.js), the installer's
 * chosen Brand, and (when provided) the warranty's single installation-wide
 * fuel type — `fuel_type IS NULL` on a product means "fuel-type-agnostic,"
 * so it always matches regardless of which fuel type the installer picked. */
const search = async (connection, { query, categories, brand, fuelType, limit = 20 }) => {
  const conditions = ['is_active = TRUE'];
  const params = [];
  if (categories && categories.length > 0) {
    conditions.push(`category IN (${categories.map(() => '?').join(',')})`);
    params.push(...categories);
  }
  if (brand) {
    conditions.push('brand = ?');
    params.push(brand);
  }
  if (fuelType) {
    conditions.push('(fuel_type IS NULL OR fuel_type = ?)');
    params.push(fuelType);
  }
  if (query) {
    conditions.push('(brand LIKE ? OR model LIKE ?)');
    params.push(`%${query}%`, `%${query}%`);
  }
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const [rows] = await connection.execute(
    `SELECT id, category, brand, model, fuel_type FROM products
     WHERE ${conditions.join(' AND ')}
     ORDER BY brand ASC, model ASC
     LIMIT ${safeLimit}`,
    params
  );
  return rows;
};

/** Distinct brand list for a Brand `Select`, scoped to the equipment slot's
 * allowed categories — same category-scoping as `search`, so a brand with
 * only e.g. injector-rail products never shows up for the Reducer row. */
const getDistinctBrands = async (connection, categories) => {
  const conditions = ['is_active = TRUE'];
  const params = [];
  if (categories && categories.length > 0) {
    conditions.push(`category IN (${categories.map(() => '?').join(',')})`);
    params.push(...categories);
  }
  const [rows] = await connection.execute(
    `SELECT DISTINCT brand FROM products WHERE ${conditions.join(' AND ')} ORDER BY brand ASC`,
    params
  );
  return rows.map((r) => r.brand);
};

const findById = async (connection, productId) => {
  const [rows] = await connection.execute('SELECT * FROM products WHERE id = ?', [productId]);
  return rows[0] || null;
};

const create = async (connection, { category, brand, model, fuel_type }) => {
  const [result] = await connection.execute(
    'INSERT INTO products (category, brand, model, fuel_type) VALUES (?, ?, ?, ?)',
    [category, brand.trim(), model?.trim() || null, fuel_type || null]
  );
  return result.insertId;
};

const update = async (connection, productId, { category, brand, model, fuel_type }) => {
  await connection.execute(
    'UPDATE products SET category = ?, brand = ?, model = ?, fuel_type = ? WHERE id = ?',
    [category, brand.trim(), model?.trim() || null, fuel_type || null, productId]
  );
};

const setActive = async (connection, productId, isActive) => {
  await connection.execute('UPDATE products SET is_active = ? WHERE id = ?', [isActive, productId]);
};

module.exports = { findAllPaginated, search, getDistinctBrands, findById, create, update, setActive };
