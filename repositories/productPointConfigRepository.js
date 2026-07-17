/**
 * All raw SQL for product_point_configs/product_point_config_history.
 * Absence of a product_point_configs row means 0 points (unconfigured) — not
 * a NULL/special state — so getPoints defaults rather than distinguishing
 * "never configured" from "configured to 0."
 */

const getPoints = async (connection, productId) => {
  const [rows] = await connection.execute(
    'SELECT points FROM product_point_configs WHERE product_id = ?',
    [productId]
  );
  return rows[0]?.points ?? 0;
};

/**
 * Upserts the config value and writes a history row in the same call —
 * old_points is read fresh here (not trusted from the caller) so the
 * history row is always accurate even under concurrent admin edits.
 */
const upsert = async (connection, { productId, points, updatedBy }) => {
  const [existingRows] = await connection.execute(
    'SELECT points FROM product_point_configs WHERE product_id = ?',
    [productId]
  );
  const oldPoints = existingRows[0]?.points ?? null;

  await connection.execute(
    `INSERT INTO product_point_configs (product_id, points, updated_by)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE points = VALUES(points), updated_by = VALUES(updated_by)`,
    [productId, points, updatedBy]
  );

  await connection.execute(
    `INSERT INTO product_point_config_history (product_id, old_points, new_points, changed_by)
     VALUES (?, ?, ?, ?)`,
    [productId, oldPoints, points, updatedBy]
  );
};

const listWithProducts = async (connection, { page, limit, search }) => {
  const conditions = [];
  const params = [];
  if (search) {
    conditions.push('(p.brand LIKE ? OR p.model LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const [countRows] = await connection.execute(
    `SELECT COUNT(*) AS total FROM products p ${whereClause}`,
    params
  );
  const [rows] = await connection.execute(
    `SELECT p.id AS product_id, p.brand, p.model, p.category, p.is_active,
            COALESCE(ppc.points, 0) AS points, ppc.updated_at
     FROM products p
     LEFT JOIN product_point_configs ppc ON ppc.product_id = p.id
     ${whereClause}
     ORDER BY p.brand, p.model
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return { rows, total: countRows[0].total };
};

module.exports = { getPoints, upsert, listWithProducts };
