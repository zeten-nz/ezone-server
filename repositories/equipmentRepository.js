const REQUIRED_EQUIPMENT_TYPES = ['REDUCER', 'CYLINDER', 'CONTROLLER', 'INJECTOR_RAIL'];

/**
 * Upserts each equipment row keyed by (warranty_form_id, equipment_type) —
 * never delete-then-reinsert, which would wipe equipment_validation_status/
 * reward_points/etc. on rows the installer didn't even touch. If an update
 * changes product_id or serial_number, the validation/reward fields reset
 * back to PENDING/NULL (nothing has re-validated the new value yet). Not
 * meaningfully exercised today since nothing sets those fields yet, but
 * wired now so the future validator integration doesn't need a redesign.
 */
const upsertMany = async (connection, warrantyFormId, equipmentRows) => {
  for (const row of equipmentRows) {
    const [existingRows] = await connection.execute(
      'SELECT product_id, serial_number FROM warranty_equipment WHERE warranty_form_id = ? AND equipment_type = ?',
      [warrantyFormId, row.equipment_type]
    );
    const existing = existingRows[0];
    const valueChanged = existing && (existing.product_id !== row.product_id || existing.serial_number !== row.serial_number);
    const resetClause = (!existing || valueChanged)
      ? `, equipment_validation_status = 'PENDING', validated_at = NULL, reward_points = NULL, reward_transaction_id = NULL, validation_response = NULL`
      : '';

    // fuel_type is never written here — it's a per-warranty value now
    // (warranty_forms.fuel_type), not per-equipment-row. The column stays
    // on this table for historical rows only (see the fuel_type migration
    // in config/database.js); new rows simply never populate it.
    await connection.execute(
      `INSERT INTO warranty_equipment (warranty_form_id, equipment_type, product_id, product_name, serial_number)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         product_id = VALUES(product_id),
         product_name = VALUES(product_name), serial_number = VALUES(serial_number)${resetClause}`,
      [warrantyFormId, row.equipment_type, row.product_id, row.product_name, row.serial_number || null]
    );
  }
};

// product_brand (joined, not stored on this table) lets the edit-warranty
// form pre-select the Brand dropdown to match the already-chosen product —
// without it, editing an existing warranty would show an empty Brand select
// next to an already-populated Product field. product_external_id is
// similarly joined-not-stored — the EasyGas sync (easyGasSyncService.js)
// needs it to build a warranty's push payload, since EasyGas identifies
// products by their own id, not ours. LEFT JOIN defensively, even though
// product_id's FK is ON DELETE RESTRICT and should make this always resolve.
const findByWarrantyFormIds = async (connection, formIds) => {
  if (formIds.length === 0) return [];
  const placeholders = formIds.map(() => '?').join(',');
  const [rows] = await connection.execute(
    `SELECT we.*, p.brand AS product_brand, p.external_id AS product_external_id
     FROM warranty_equipment we
     LEFT JOIN products p ON p.id = we.product_id
     WHERE we.warranty_form_id IN (${placeholders})
     ORDER BY FIELD(we.equipment_type, 'REDUCER', 'CYLINDER', 'CONTROLLER', 'INJECTOR_RAIL')`,
    formIds
  );
  return rows;
};

module.exports = { REQUIRED_EQUIPMENT_TYPES, upsertMany, findByWarrantyFormIds };
