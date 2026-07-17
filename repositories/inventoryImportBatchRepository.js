/**
 * All raw SQL for inventory_import_batches — one row per CSV upload,
 * doubling as the CSV import audit trail (who, when, file, exact counts).
 */

const create = async (connection, { productId, uploadedBy, fileName, totalRows, importedCount, skippedCount, duplicateCount, errorCount }) => {
  const [result] = await connection.execute(
    `INSERT INTO inventory_import_batches
       (product_id, uploaded_by, file_name, total_rows, imported_count, skipped_count, duplicate_count, error_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [productId, uploadedBy, fileName || null, totalRows, importedCount, skippedCount, duplicateCount, errorCount]
  );
  return result.insertId;
};

const findAllPaginated = async (connection, { page, limit }) => {
  const offset = (page - 1) * limit;
  const [countRows] = await connection.execute('SELECT COUNT(*) AS total FROM inventory_import_batches');
  const [rows] = await connection.execute(
    `SELECT b.*, p.brand AS product_brand, p.model AS product_model, u.full_name AS uploaded_by_name
     FROM inventory_import_batches b
     JOIN products p ON p.id = b.product_id
     JOIN users u ON u.id = b.uploaded_by
     ORDER BY b.created_at DESC LIMIT ${limit} OFFSET ${offset}`
  );
  return { rows, total: countRows[0].total };
};

const findById = async (connection, id) => {
  const [rows] = await connection.execute(
    `SELECT b.*, p.brand AS product_brand, p.model AS product_model, u.full_name AS uploaded_by_name
     FROM inventory_import_batches b
     JOIN products p ON p.id = b.product_id
     JOIN users u ON u.id = b.uploaded_by
     WHERE b.id = ?`,
    [id]
  );
  return rows[0] || null;
};

module.exports = { create, findAllPaginated, findById };
