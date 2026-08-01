/**
 * All raw SQL for the brands catalog — local ERP master data (equipment
 * brands like "STAG", "ADAX"). products.brand_id links to this table; the
 * free-text products.brand column stays denormalized from brands.name for
 * every existing read path that already keys off it (search/getDistinctBrands
 * in productRepository.js), same convention as every other admin catalog
 * table in this app (products, branches).
 */

const findAllPaginated = async (connection, { page, limit, search }) => {
  const offset = (page - 1) * limit;
  const conditions = [];
  const params = [];
  if (search) {
    conditions.push('name LIKE ?');
    params.push(`%${search}%`);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countRows] = await connection.execute(`SELECT COUNT(*) AS total FROM brands ${whereClause}`, params);
  const [rows] = await connection.execute(
    `SELECT * FROM brands ${whereClause} ORDER BY name ASC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return { rows, total: countRows[0].total };
};

/** Active brands only — powers the Product form's Brand select. */
const findAllActive = async (connection) => {
  const [rows] = await connection.execute('SELECT id, name FROM brands WHERE is_active = TRUE ORDER BY name ASC');
  return rows;
};

const findById = async (connection, brandId) => {
  const [rows] = await connection.execute('SELECT * FROM brands WHERE id = ?', [brandId]);
  return rows[0] || null;
};

const create = async (connection, { name, full_name, country, logo_url }) => {
  const [result] = await connection.execute(
    'INSERT INTO brands (name, full_name, country, logo_url) VALUES (?, ?, ?, ?)',
    [name.trim(), full_name?.trim() || null, country?.trim() || null, logo_url?.trim() || null]
  );
  return result.insertId;
};

const update = async (connection, brandId, { name, full_name, country, logo_url }) => {
  await connection.execute(
    'UPDATE brands SET name = ?, full_name = ?, country = ?, logo_url = ? WHERE id = ?',
    [name.trim(), full_name?.trim() || null, country?.trim() || null, logo_url?.trim() || null, brandId]
  );
};

const setActive = async (connection, brandId, isActive) => {
  await connection.execute('UPDATE brands SET is_active = ? WHERE id = ?', [isActive, brandId]);
};

module.exports = { findAllPaginated, findAllActive, findById, create, update, setActive };
