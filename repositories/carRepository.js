/**
 * All raw SQL for the local car (vehicle) catalog — standard ERP master
 * data (e.g. "Chevrolet Cobalt"), admin-managed like products/brands.
 * Powers the warranty form's Vehicle Name catalog-first autocomplete; free
 * text always remains a valid fallback at the caller's discretion.
 */

const findAllPaginated = async (connection, { page, limit, search }) => {
  const offset = (page - 1) * limit;
  const conditions = [];
  const params = [];
  if (search) {
    conditions.push('(brand LIKE ? OR model LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countRows] = await connection.execute(`SELECT COUNT(*) AS total FROM cars ${whereClause}`, params);
  const [rows] = await connection.execute(
    `SELECT * FROM cars ${whereClause} ORDER BY brand ASC, model ASC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return { rows, total: countRows[0].total };
};

const search = async (connection, { query, limit = 20 }) => {
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const [rows] = await connection.execute(
    `SELECT id, brand, model FROM cars
     WHERE is_active = TRUE AND (brand LIKE ? OR model LIKE ?)
     ORDER BY brand ASC, model ASC
     LIMIT ${safeLimit}`,
    [`%${query}%`, `%${query}%`]
  );
  return rows;
};

const findById = async (connection, carId) => {
  const [rows] = await connection.execute('SELECT * FROM cars WHERE id = ?', [carId]);
  return rows[0] || null;
};

const create = async (connection, { brand, model }) => {
  const [result] = await connection.execute(
    'INSERT INTO cars (brand, model) VALUES (?, ?)',
    [brand.trim(), model.trim()]
  );
  return result.insertId;
};

const update = async (connection, carId, { brand, model }) => {
  await connection.execute(
    'UPDATE cars SET brand = ?, model = ? WHERE id = ?',
    [brand.trim(), model.trim(), carId]
  );
};

const setActive = async (connection, carId, isActive) => {
  await connection.execute('UPDATE cars SET is_active = ? WHERE id = ?', [isActive, carId]);
};

module.exports = { findAllPaginated, search, findById, create, update, setActive };
