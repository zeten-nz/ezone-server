/**
 * Read-only search over the locally mirrored EasyGas car catalog — powers
 * the warranty form's Vehicle Name catalog-first autocomplete (see
 * config/database.js's `cars` table, populated by
 * services/easyGasCatalogSyncService.js). Free text always remains a valid
 * fallback at the caller's discretion; this repository has no concept of
 * "required" — it just returns matches.
 */
const search = async (connection, { query, limit = 20 }) => {
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const [rows] = await connection.execute(
    `SELECT id, brand, model FROM cars
     WHERE (brand LIKE ? OR model LIKE ?)
     ORDER BY brand ASC, model ASC
     LIMIT ${safeLimit}`,
    [`%${query}%`, `%${query}%`]
  );
  return rows;
};

module.exports = { search };
