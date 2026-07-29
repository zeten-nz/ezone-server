/**
 * All raw SQL for the physical-inventory ledger (inventory_items) and its
 * status history. product_id/barcode identity is set once at CSV import;
 * every status transition after that goes through claimForInstallation/
 * release (atomic, race-guarded) or a future manual changeStatus — never a
 * bare UPDATE written ad hoc elsewhere.
 */

const findByBarcode = async (connection, barcode) => {
  const [rows] = await connection.execute(
    `SELECT i.*, p.category, p.brand, p.model, p.is_active AS product_is_active
     FROM inventory_items i
     JOIN products p ON p.id = i.product_id
     WHERE i.barcode = ?`,
    [barcode]
  );
  return rows[0] || null;
};

const findExistingBarcodes = async (connection, barcodes) => {
  if (barcodes.length === 0) return new Set();
  const placeholders = barcodes.map(() => '?').join(',');
  const [rows] = await connection.execute(
    `SELECT barcode FROM inventory_items WHERE barcode IN (${placeholders})`,
    barcodes
  );
  return new Set(rows.map((r) => r.barcode));
};

// A per-row insert loop does not scale to the "hundreds or thousands" of
// barcodes a real CSV import contains — chunked multi-row INSERT instead.
// branchId ("warehouse", Phase 4) is nullable, same as before — existing
// imports that don't specify one keep working exactly as they always did.
const CHUNK_SIZE = 500;
const bulkInsert = async (connection, { productId, barcodes, importBatchId, branchId }) => {
  for (let i = 0; i < barcodes.length; i += CHUNK_SIZE) {
    const chunk = barcodes.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '(?, ?, ?, ?)').join(', ');
    const params = chunk.flatMap((barcode) => [productId, barcode, importBatchId, branchId || null]);
    await connection.execute(
      `INSERT INTO inventory_items (product_id, barcode, import_batch_id, branch_id) VALUES ${placeholders}`,
      params
    );
  }
};

/**
 * Looks up the ids bulkInsert just created, by (product_id, barcode) —
 * bulkInsert's multi-row INSERT doesn't return generated ids per row.
 * Correct even under concurrent imports since barcode is globally UNIQUE.
 */
const findIdsByBarcodes = async (connection, { productId, barcodes }) => {
  if (barcodes.length === 0) return [];
  const placeholders = barcodes.map(() => '?').join(',');
  const [rows] = await connection.execute(
    `SELECT id FROM inventory_items WHERE product_id = ? AND barcode IN (${placeholders})`,
    [productId, ...barcodes]
  );
  return rows.map((r) => r.id);
};

/**
 * Chunked companion to bulkInsert — one history row per freshly-imported
 * item (fromStatus NULL, since it didn't exist before this import). Same
 * chunk size/reasoning as bulkInsert: a per-row loop doesn't scale to a
 * real CSV import's row count.
 */
const bulkInsertStatusHistory = async (connection, { itemIds, toStatus, changedBy, reason }) => {
  for (let i = 0; i < itemIds.length; i += CHUNK_SIZE) {
    const chunk = itemIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '(?, NULL, ?, ?, ?)').join(', ');
    const params = chunk.flatMap((itemId) => [itemId, toStatus, changedBy || null, reason || null]);
    await connection.execute(
      `INSERT INTO inventory_status_history (inventory_item_id, from_status, to_status, changed_by, reason) VALUES ${placeholders}`,
      params
    );
  }
};

/**
 * Phase 4 adds installerId/branchId/importBatchId/installedFrom-To/
 * claimedFrom-To on top of the original productId/status/search filters,
 * each an additional AND clause in the same conditions-array shape as
 * before — no new pattern introduced. `status` omitted means "any status
 * except MERGED": a merged duplicate is the same physical unit as its
 * canonical item and must never appear in the general listing/total (Phase
 * 4 plan D4) — pass status:'MERGED' explicitly to audit past merges.
 * claimedFrom/claimedTo pins each item's MOST RECENT 'INSTALLED' transition
 * (via the correlated MAX(id) subquery), not just any historical match —
 * an item claimed in January, released, and reclaimed in March for a
 * different warranty must not match a January claim-date filter (see the
 * Phase 4 plan's independent review finding on this exact scenario).
 */
const findAllPaginated = async (connection, {
  page, limit, productId, status, search,
  installerId, branchId, importBatchId, installedFrom, installedTo, claimedFrom, claimedTo,
}) => {
  const conditions = [];
  const params = [];
  if (productId) {
    conditions.push('i.product_id = ?');
    params.push(productId);
  }
  if (status) {
    conditions.push('i.status = ?');
    params.push(status);
  } else {
    conditions.push("i.status != 'MERGED'");
  }
  if (search) {
    conditions.push('i.barcode LIKE ?');
    params.push(`%${search}%`);
  }
  if (branchId) {
    conditions.push('i.branch_id = ?');
    params.push(branchId);
  }
  if (importBatchId) {
    conditions.push('i.import_batch_id = ?');
    params.push(importBatchId);
  }
  if (installerId) {
    conditions.push(`EXISTS (
      SELECT 1 FROM warranty_equipment we
      JOIN warranty_forms wf ON wf.id = we.warranty_form_id
      WHERE we.inventory_item_id = i.id AND wf.employee_id = ?
    )`);
    params.push(installerId);
  }
  if (installedFrom || installedTo) {
    conditions.push(`EXISTS (
      SELECT 1 FROM warranty_equipment we
      JOIN warranty_forms wf ON wf.id = we.warranty_form_id
      WHERE we.inventory_item_id = i.id
        ${installedFrom ? 'AND wf.installation_date >= ?' : ''}
        ${installedTo ? 'AND wf.installation_date <= ?' : ''}
    )`);
    if (installedFrom) params.push(installedFrom);
    if (installedTo) params.push(installedTo);
  }
  if (claimedFrom || claimedTo) {
    conditions.push(`EXISTS (
      SELECT 1 FROM inventory_status_history h
      WHERE h.inventory_item_id = i.id
        AND h.to_status = 'INSTALLED'
        AND h.id = (
          SELECT MAX(h2.id) FROM inventory_status_history h2
          WHERE h2.inventory_item_id = h.inventory_item_id AND h2.to_status = 'INSTALLED'
        )
        ${claimedFrom ? 'AND h.created_at >= ?' : ''}
        ${claimedTo ? 'AND h.created_at <= ?' : ''}
    )`);
    if (claimedFrom) params.push(claimedFrom);
    if (claimedTo) params.push(claimedTo);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const [countRows] = await connection.execute(
    `SELECT COUNT(*) AS total FROM inventory_items i ${whereClause}`,
    params
  );
  const [rows] = await connection.execute(
    `SELECT i.*, p.brand, p.model, p.category, b.name AS branch_name
     FROM inventory_items i
     JOIN products p ON p.id = i.product_id
     LEFT JOIN branches b ON b.id = i.branch_id
     ${whereClause}
     ORDER BY i.created_at DESC, i.id DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return { rows, total: countRows[0].total };
};

const insertStatusHistory = async (connection, { inventoryItemId, fromStatus, toStatus, changedBy, reason }) => {
  await connection.execute(
    `INSERT INTO inventory_status_history (inventory_item_id, from_status, to_status, changed_by, reason)
     VALUES (?, ?, ?, ?, ?)`,
    [inventoryItemId, fromStatus || null, toStatus, changedBy || null, reason || null]
  );
};

/**
 * Atomic claim — same race-guard shape as easyGasSyncSweep.js's
 * UPDATE ... WHERE status='PENDING' LIMIT 1 pattern, checked via
 * affectedRows. Not yet called by anything (warranty integration is
 * Phase 2) — present now so Phase 2 doesn't need new repository plumbing.
 */
const claimForInstallation = async (connection, { itemId, productId }) => {
  const [result] = await connection.execute(
    `UPDATE inventory_items SET status = 'INSTALLED' WHERE id = ? AND product_id = ? AND status = 'IN_STOCK' LIMIT 1`,
    [itemId, productId]
  );
  return result.affectedRows === 1;
};

const release = async (connection, itemId) => {
  const [result] = await connection.execute(
    `UPDATE inventory_items SET status = 'IN_STOCK' WHERE id = ? AND status = 'INSTALLED' LIMIT 1`,
    [itemId]
  );
  return result.affectedRows === 1;
};

const findById = async (connection, itemId) => {
  const [rows] = await connection.execute(
    `SELECT i.*, p.brand, p.model, p.category
     FROM inventory_items i JOIN products p ON p.id = i.product_id
     WHERE i.id = ?`,
    [itemId]
  );
  return rows[0] || null;
};

/**
 * Phase 4 manual operations — all atomic, guarded UPDATEs (never a bare
 * read-then-write), same discipline as claimForInstallation/release above.
 * Each returns a boolean via affectedRows so the service layer can tell
 * "the item's real state changed since the admin loaded the page" apart
 * from a genuine success, exactly like the existing claim/release callers do.
 */

// Bound to the admin's *observed* fromStatus — if the real row has already
// moved (e.g. just got claimed by a warranty submission), affectedRows is 0
// and the caller fails cleanly instead of overwriting the concurrent change.
const changeStatusManually = async (connection, { itemId, fromStatus, toStatus }) => {
  const [result] = await connection.execute(
    `UPDATE inventory_items SET status = ? WHERE id = ? AND status = ? LIMIT 1`,
    [toStatus, itemId, fromStatus]
  );
  return result.affectedRows === 1;
};

const transferBranch = async (connection, { itemId, branchId }) => {
  const [result] = await connection.execute(
    `UPDATE inventory_items SET branch_id = ? WHERE id = ? LIMIT 1`,
    [branchId, itemId]
  );
  return result.affectedRows === 1;
};

// Restricted to non-INSTALLED items at the service layer (see
// inventoryService.correctBarcode) — this UPDATE itself only guards against
// the barcode having changed underneath the admin (rare, but the same
// discipline applies) via affectedRows, not the status restriction, which
// needs a fresher read than a single UPDATE's WHERE clause can express
// cleanly against a value the admin didn't submit.
const correctBarcode = async (connection, { itemId, oldBarcode, newBarcode }) => {
  const [result] = await connection.execute(
    `UPDATE inventory_items SET barcode = ? WHERE id = ? AND barcode = ? LIMIT 1`,
    [newBarcode, itemId, oldBarcode]
  );
  return result.affectedRows === 1;
};

// The AND status='IN_STOCK' clause is what actually *enforces* "never merge
// an INSTALLED item," atomically — not just an application-level check that
// could race a concurrent claim (see the Phase 4 plan's D2/D4).
const mergeDuplicate = async (connection, { duplicateItemId, canonicalItemId }) => {
  const [result] = await connection.execute(
    `UPDATE inventory_items SET status = 'MERGED', merged_into_id = ? WHERE id = ? AND status = 'IN_STOCK' LIMIT 1`,
    [canonicalItemId, duplicateItemId]
  );
  return result.affectedRows === 1;
};

/**
 * Status breakdown for reports/dashboard — includes a MERGED bucket (an
 * admin auditing past merges needs to see it), but callers computing a
 * *summed* "total inventory" figure must explicitly exclude it themselves
 * (Phase 4 plan D4) since a merged duplicate is the same physical unit as
 * its canonical item.
 */
const getStatusBreakdown = async (connection, { branchId } = {}) => {
  const params = [];
  let branchClause = '';
  if (branchId) {
    branchClause = 'WHERE branch_id = ?';
    params.push(branchId);
  }
  const [rows] = await connection.execute(
    `SELECT status, COUNT(*) AS count FROM inventory_items ${branchClause} GROUP BY status`,
    params
  );
  return rows;
};

const getImportedCounts = async (connection) => {
  const [rows] = await connection.execute(
    `SELECT
       SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END) AS today,
       SUM(CASE WHEN YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE()) THEN 1 ELSE 0 END) AS thisMonth
     FROM inventory_items`
  );
  return { today: Number(rows[0].today) || 0, thisMonth: Number(rows[0].thisMonth) || 0 };
};

/** Per-branch ("warehouse") stock breakdown for the warehouse statistics
 * page and "Top Warehouses" report — MERGED excluded from every count here
 * since it's not real distinct stock (Phase 4 plan D4). */
const getBranchStockBreakdown = async (connection, { branchId } = {}) => {
  const params = [];
  let branchClause = "WHERE i.status != 'MERGED'";
  if (branchId) {
    branchClause += ' AND i.branch_id = ?';
    params.push(branchId);
  }
  const [rows] = await connection.execute(
    `SELECT i.branch_id, b.name AS branch_name,
            COUNT(*) AS total,
            SUM(CASE WHEN i.status = 'IN_STOCK' THEN 1 ELSE 0 END) AS in_stock,
            SUM(CASE WHEN i.status = 'INSTALLED' THEN 1 ELSE 0 END) AS installed,
            SUM(CASE WHEN i.status = 'RESERVED' THEN 1 ELSE 0 END) AS reserved,
            SUM(CASE WHEN i.status = 'DAMAGED' THEN 1 ELSE 0 END) AS damaged,
            SUM(CASE WHEN i.status = 'RETURNED' THEN 1 ELSE 0 END) AS returned,
            SUM(CASE WHEN i.status = 'LOST' THEN 1 ELSE 0 END) AS lost
     FROM inventory_items i
     LEFT JOIN branches b ON b.id = i.branch_id
     ${branchClause}
     GROUP BY i.branch_id, b.name
     ORDER BY total DESC`,
    params
  );
  return rows;
};

const getRecentActivity = async (connection, { limit, branchId } = {}) => {
  const params = [];
  let branchClause = '';
  if (branchId) {
    branchClause = 'AND i.branch_id = ?';
    params.push(branchId);
  }
  const [rows] = await connection.execute(
    `SELECT h.id, h.inventory_item_id, h.from_status, h.to_status, h.reason, h.created_at,
            i.barcode, p.brand, p.model, u.full_name AS changed_by_name
     FROM inventory_status_history h
     JOIN inventory_items i ON i.id = h.inventory_item_id
     JOIN products p ON p.id = i.product_id
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE 1=1 ${branchClause}
     ORDER BY h.created_at DESC, h.id DESC
     LIMIT ${Number(limit) || 20}`,
    params
  );
  return rows;
};

/** Per-product statistics — imported/installed/remaining/failure(damaged)/
 * return rates, top installers/branches for that product. MERGED excluded
 * from every count (Phase 4 plan D4). */
const getProductStatistics = async (connection, productId) => {
  const [[counts]] = await connection.execute(
    `SELECT
       COUNT(*) AS imported,
       SUM(CASE WHEN status = 'INSTALLED' THEN 1 ELSE 0 END) AS installed,
       SUM(CASE WHEN status = 'IN_STOCK' THEN 1 ELSE 0 END) AS remaining,
       SUM(CASE WHEN status = 'DAMAGED' THEN 1 ELSE 0 END) AS damaged,
       SUM(CASE WHEN status = 'RETURNED' THEN 1 ELSE 0 END) AS returned
     FROM inventory_items WHERE product_id = ? AND status != 'MERGED'`,
    [productId]
  );
  // Manual Verification: excludes PENDING/REJECTED rows — a top-installers/
  // top-branches ranking "for this product" should reflect confirmed
  // installations (AUTO or admin-APPROVED), same reasoning as
  // reportsController.getProductsInstalled.
  const [topInstallers] = await connection.execute(
    `SELECT u.id, u.full_name, COUNT(*) AS count
     FROM warranty_equipment we
     JOIN warranty_forms wf ON wf.id = we.warranty_form_id
     JOIN users u ON u.id = wf.employee_id
     WHERE we.product_id = ? AND we.verification_status NOT IN ('PENDING', 'REJECTED')
     GROUP BY u.id, u.full_name
     ORDER BY count DESC LIMIT 10`,
    [productId]
  );
  const [topBranches] = await connection.execute(
    `SELECT b.id, b.name, COUNT(*) AS count
     FROM warranty_equipment we
     JOIN warranty_forms wf ON wf.id = we.warranty_form_id
     JOIN users u ON u.id = wf.employee_id
     JOIN branches b ON b.id = u.branch_id
     WHERE we.product_id = ? AND we.verification_status NOT IN ('PENDING', 'REJECTED')
     GROUP BY b.id, b.name
     ORDER BY count DESC LIMIT 10`,
    [productId]
  );
  return { counts, topInstallers, topBranches };
};

/** Keyset-paginated chunk for CSV export — see warrantyRepository's
 * findChunkForExport for why this isn't OFFSET-based (Phase 4 plan D6).
 * Excludes MERGED, same default as findAllPaginated. */
const findChunkForExport = async (connection, { lastId, limit }) => {
  const [rows] = await connection.execute(
    `SELECT i.*, p.brand, p.model, p.category, b.name AS branch_name
     FROM inventory_items i
     JOIN products p ON p.id = i.product_id
     LEFT JOIN branches b ON b.id = i.branch_id
     WHERE i.id > ? AND i.status != 'MERGED'
     ORDER BY i.id ASC LIMIT ${Number(limit)}`,
    [lastId]
  );
  return rows;
};

module.exports = {
  findByBarcode,
  findExistingBarcodes,
  findIdsByBarcodes,
  bulkInsert,
  bulkInsertStatusHistory,
  findAllPaginated,
  insertStatusHistory,
  claimForInstallation,
  release,
  findById,
  changeStatusManually,
  transferBranch,
  correctBarcode,
  mergeDuplicate,
  getStatusBreakdown,
  getImportedCounts,
  getBranchStockBreakdown,
  getRecentActivity,
  getProductStatistics,
  findChunkForExport,
};
