/**
 * All raw SQL for the installer points ledger (point_transactions) — an
 * append-only table, never UPDATEd or DELETEd by any code path. Every award,
 * reversal, and manual adjustment is its own row; "current balance" is
 * always a live SUM, never a stored value (see the Phase 3 plan's Design
 * Decision 2 — the ledger is small enough that this is always cheap and
 * always correct).
 */

const insert = async (connection, {
  installerId, points, transactionType, warrantyFormId, warrantyEquipmentId,
  productId, reversedTransactionId, reason, idempotencyKey, createdBy,
}) => {
  const [result] = await connection.execute(
    `INSERT INTO point_transactions
       (installer_id, points, transaction_type, warranty_form_id, warranty_equipment_id,
        product_id, reversed_transaction_id, reason, idempotency_key, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      installerId, points, transactionType, warrantyFormId || null, warrantyEquipmentId || null,
      productId || null, reversedTransactionId || null, reason || null, idempotencyKey || null, createdBy,
    ]
  );
  return result.insertId;
};

const findByIdempotencyKey = async (connection, idempotencyKey) => {
  const [rows] = await connection.execute(
    'SELECT * FROM point_transactions WHERE idempotency_key = ?',
    [idempotencyKey]
  );
  return rows[0] || null;
};

/**
 * The running net for one specific warranty_equipment row, plus the
 * installer it was credited to — used by reverseForEquipmentRow to compute
 * both "how much to reverse" and "who to reverse it for" from the ledger
 * itself, since callers (especially deleteWarrantyForm) don't always have
 * the installer's identity in scope. Every award for a given
 * warranty_equipment_id is always credited to that warranty's one owner
 * (ownership never changes via edit), so GROUP BY installer_id always
 * collapses to at most one row.
 */
const netForEquipmentRow = async (connection, warrantyEquipmentId) => {
  const [rows] = await connection.execute(
    `SELECT installer_id, SUM(points) AS net
     FROM point_transactions
     WHERE warranty_equipment_id = ?
     GROUP BY installer_id`,
    [warrantyEquipmentId]
  );
  return rows[0] || null;
};

/** Most recent WARRANTY_AWARD for a row — its id becomes the reversal's
 * best-effort reversed_transaction_id admin-UI pointer (never the reversal
 * amount itself, that's always netForEquipmentRow's live SUM), and its
 * product_id is carried onto the reversal row too, since a reversal is
 * always undoing the most recent award for that row and "which product"
 * should stay answerable on the reversal row itself, not just the award. */
const mostRecentAwardForEquipmentRow = async (connection, warrantyEquipmentId) => {
  const [rows] = await connection.execute(
    `SELECT id, product_id FROM point_transactions
     WHERE warranty_equipment_id = ? AND transaction_type = 'WARRANTY_AWARD'
     ORDER BY id DESC LIMIT 1`,
    [warrantyEquipmentId]
  );
  return rows[0] || null;
};

const getInstallerTotal = async (connection, installerId) => {
  const [rows] = await connection.execute(
    'SELECT COALESCE(SUM(points), 0) AS total FROM point_transactions WHERE installer_id = ?',
    [installerId]
  );
  return rows[0].total;
};

const findByInstaller = async (connection, installerId, { page, limit }) => {
  const offset = (page - 1) * limit;
  const [countRows] = await connection.execute(
    'SELECT COUNT(*) AS total FROM point_transactions WHERE installer_id = ?',
    [installerId]
  );
  const [rows] = await connection.execute(
    `SELECT pt.*, p.brand AS product_brand, p.model AS product_model, u.full_name AS created_by_name
     FROM point_transactions pt
     LEFT JOIN products p ON p.id = pt.product_id
     LEFT JOIN users u ON u.id = pt.created_by
     WHERE pt.installer_id = ?
     ORDER BY pt.created_at DESC, pt.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
    [installerId]
  );
  return { rows, total: countRows[0].total };
};

/**
 * Points Leaderboard (Phase 4) — a genuinely new, separate report from the
 * existing warranty-count getTopInstallers (see the Phase 4 plan's Critical
 * Review #7): "most warranties submitted" and "most points earned" are
 * different rankings that can disagree. `since` optionally scopes to a
 * date range (e.g. "this month") for a monthly leaderboard; omitted means
 * lifetime. Only real installers (role='EMPLOYEE') are ranked, matching
 * getTopInstallers' own WHERE u.role='EMPLOYEE' precedent — a Super Admin's
 * manual-adjustment target could theoretically be an ADMIN account, but
 * that's not a real "installer" for leaderboard purposes.
 */
const getLeaderboard = async (connection, { limit, since } = {}) => {
  const params = [];
  let sinceClause = '';
  if (since) {
    sinceClause = 'AND pt.created_at >= ?';
    params.push(since);
  }
  const [rows] = await connection.execute(
    `SELECT u.id AS installer_id, u.full_name, u.branch_id, b.name AS branch_name,
            COALESCE(SUM(pt.points), 0) AS total
     FROM users u
     LEFT JOIN branches b ON b.id = u.branch_id
     LEFT JOIN point_transactions pt ON pt.installer_id = u.id ${sinceClause}
     WHERE u.role = 'EMPLOYEE'
     GROUP BY u.id, u.full_name, u.branch_id, b.name
     ORDER BY total DESC
     LIMIT ${Number(limit) || 10}`,
    params
  );
  return rows;
};

/** Points earned so far in the current calendar month, for one installer —
 * used by the installer statistics page's "Monthly points" figure. */
const getMonthlyTotal = async (connection, installerId) => {
  const [rows] = await connection.execute(
    `SELECT COALESCE(SUM(points), 0) AS total FROM point_transactions
     WHERE installer_id = ? AND YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())`,
    [installerId]
  );
  return rows[0].total;
};

/** Keyset-paginated chunk for CSV export — see warrantyRepository's
 * findChunkForExport for why this isn't OFFSET-based (Phase 4 plan D6). */
const findChunkForExport = async (connection, { lastId, limit }) => {
  const [rows] = await connection.execute(
    `SELECT pt.*, u.full_name AS installer_name, p.brand AS product_brand, p.model AS product_model
     FROM point_transactions pt
     JOIN users u ON u.id = pt.installer_id
     LEFT JOIN products p ON p.id = pt.product_id
     WHERE pt.id > ?
     ORDER BY pt.id ASC LIMIT ${Number(limit)}`,
    [lastId]
  );
  return rows;
};

module.exports = {
  insert,
  findByIdempotencyKey,
  netForEquipmentRow,
  mostRecentAwardForEquipmentRow,
  getInstallerTotal,
  findByInstaller,
  getLeaderboard,
  getMonthlyTotal,
  findChunkForExport,
};
