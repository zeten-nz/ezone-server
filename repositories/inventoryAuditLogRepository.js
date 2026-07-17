/**
 * All raw SQL for inventory_audit_log — the audit trail for the 3 manual
 * corrections that don't fit inventory_status_history's from/to-status
 * shape (branch transfer, barcode correction, merge). Append-only, same
 * discipline as inventory_status_history: never UPDATEd or DELETEd.
 */

const insert = async (connection, { inventoryItemId, actionType, oldValue, newValue, reason, changedBy }) => {
  await connection.execute(
    `INSERT INTO inventory_audit_log (inventory_item_id, action_type, old_value, new_value, reason, changed_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [inventoryItemId, actionType, oldValue ?? null, newValue ?? null, reason, changedBy]
  );
};

const findByItem = async (connection, inventoryItemId) => {
  const [rows] = await connection.execute(
    `SELECT a.*, u.full_name AS changed_by_name
     FROM inventory_audit_log a
     LEFT JOIN users u ON u.id = a.changed_by
     WHERE a.inventory_item_id = ?
     ORDER BY a.created_at DESC, a.id DESC`,
    [inventoryItemId]
  );
  return rows;
};

module.exports = { insert, findByItem };
