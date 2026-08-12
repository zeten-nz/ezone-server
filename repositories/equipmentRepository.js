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
      'SELECT product_id, serial_number, brand_name, model FROM warranty_equipment WHERE warranty_form_id = ? AND equipment_type = ?',
      [warrantyFormId, row.equipment_type]
    );
    const existing = existingRows[0];
    // brand_name/model only ever differ for a typed cylinder — a no-op
    // comparison for the other 3 types, which always have both null.
    const valueChanged = existing && (
      existing.product_id !== row.product_id || existing.serial_number !== row.serial_number
      || existing.brand_name !== row.brand_name || existing.model !== row.model
    );
    // Manual Verification workflow: reviewed_by/reviewed_at/review_notes are
    // NEVER part of the main VALUES() list below (they're owned exclusively
    // by equipmentRepository.reviewVerification, never by this function) —
    // but a prior review must not silently linger attached to a row whose
    // underlying identity (product/barcode) just changed underneath it, so
    // they reset alongside the existing dormant validation/reward fields on
    // the exact same valueChanged trigger.
    const resetClause = (!existing || valueChanged)
      ? `, equipment_validation_status = 'PENDING', validated_at = NULL, reward_points = NULL, reward_transaction_id = NULL, validation_response = NULL, reviewed_by = NULL, reviewed_at = NULL, review_notes = NULL`
      : '';

    // fuel_type is never written here — it's a per-warranty value now
    // (warranty_forms.fuel_type), not per-equipment-row. The column stays
    // on this table for historical rows only (see the fuel_type migration
    // in config/database.js); new rows simply never populate it.
    //
    // inventory_item_id: this function does NOT decide whether to
    // claim/release an inventory item — that decision (and the actual
    // claim/release side effect) is made one layer up, in warrantyService,
    // before upsertMany is ever called (see the Phase 2 plan's Critical
    // Review #3 — deliberately not folding a second diff into this
    // function's existing valueChanged check). This just writes whatever
    // final value the caller already resolved.
    //
    // verification_status/seller_name/seller_phone/verification_comment/
    // manual_verification_photo_filename: same treatment as inventory_item_id
    // above — warrantyService.resolveEquipment (and updateWarrantyForm's
    // per-row loop) already decided the final value for THIS save, whether
    // that's a freshly-resolved AUTO/PENDING outcome for a changed row or a
    // carried-over value for an unchanged one. This function only persists it.
    await connection.execute(
      `INSERT INTO warranty_equipment (
         warranty_form_id, equipment_type, product_id, product_name, serial_number, inventory_item_id, brand_name, model,
         verification_status, seller_name, seller_phone, verification_comment, manual_verification_photo_filename
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         product_id = VALUES(product_id),
         product_name = VALUES(product_name), serial_number = VALUES(serial_number),
         inventory_item_id = VALUES(inventory_item_id),
         brand_name = VALUES(brand_name), model = VALUES(model),
         verification_status = VALUES(verification_status), seller_name = VALUES(seller_name),
         seller_phone = VALUES(seller_phone), verification_comment = VALUES(verification_comment),
         manual_verification_photo_filename = VALUES(manual_verification_photo_filename)${resetClause}`,
      [
        warrantyFormId, row.equipment_type, row.product_id, row.product_name, row.serial_number || null, row.inventory_item_id || null, row.brand_name || null, row.model || null,
        row.verification_status, row.seller_name || null, row.seller_phone || null, row.verification_comment || null, row.manual_verification_photo_filename || null,
      ]
    );
  }
};

/**
 * Single equipment row by its own id, with the same product join
 * findByWarrantyFormIds already uses — needed by the manual-verification
 * review action, which addresses a row directly rather than through its
 * parent warranty (see warrantyService.reviewManualVerification).
 */
const findById = async (connection, equipmentId) => {
  const [rows] = await connection.execute(
    `SELECT we.*, p.brand AS product_brand, p.category AS product_category
     FROM warranty_equipment we
     LEFT JOIN products p ON p.id = we.product_id
     WHERE we.id = ?`,
    [equipmentId]
  );
  return rows[0] || null;
};

/**
 * Atomic guarded UPDATE — the actual enforcement point for a manual-
 * verification review, same shape as registrationRequestController's
 * approve/reject guard and inventoryRepository.claimForInstallation:
 * `affectedRows === 1` is the only signal that matters. Guarded on
 * verification_status = 'PENDING' so a duplicate/concurrent review request
 * can never re-review (and, critically, never re-award points) an already-
 * decided row — the caller (warrantyService.reviewManualVerification) treats
 * a false return as "already reviewed" and rejects the request accordingly.
 * `decision` is always 'APPROVED' or 'REJECTED', validated by the caller.
 */
const reviewVerification = async (connection, { equipmentId, decision, reviewedBy, notes }) => {
  const [result] = await connection.execute(
    `UPDATE warranty_equipment
     SET verification_status = ?, reviewed_by = ?, reviewed_at = NOW(), review_notes = ?
     WHERE id = ? AND verification_status = 'PENDING'`,
    [decision, reviewedBy, notes || null, equipmentId]
  );
  return result.affectedRows === 1;
};

// product_brand (joined, not stored on this table) lets the edit-warranty
// form pre-select the Brand dropdown to match the already-chosen product —
// without it, editing an existing warranty would show an empty Brand select
// next to an already-populated Product field. LEFT JOIN defensively, even
// though product_id's FK is ON DELETE RESTRICT and should make this always
// resolve. reviewed_by_name — same joined-not-stored treatment as
// product_brand above, mirroring registration_requests' own reviewer_name
// join (registrationRequestController.js) so the admin detail view can show
// who reviewed a Manual Verification row without a separate lookup.
// product_external_id: EasyGas's own catalog id for this product (see
// products.external_id), needed only by easyGasWarrantySyncService's
// components[].product_id mapping — added here rather than a separate
// lookup so that sync doesn't need its own N+1 query. NULL for any product
// created after the old catalog-sync integration was removed; harmless for
// every other existing caller, which already ignores unrecognized fields.
const findByWarrantyFormIds = async (connection, formIds) => {
  if (formIds.length === 0) return [];
  const placeholders = formIds.map(() => '?').join(',');
  const [rows] = await connection.execute(
    `SELECT we.*, p.brand AS product_brand, p.category AS product_category, p.external_id AS product_external_id,
            ru.full_name AS reviewed_by_name
     FROM warranty_equipment we
     LEFT JOIN products p ON p.id = we.product_id
     LEFT JOIN users ru ON ru.id = we.reviewed_by
     WHERE we.warranty_form_id IN (${placeholders})
     ORDER BY FIELD(we.equipment_type, 'REDUCER', 'CYLINDER', 'CONTROLLER', 'INJECTOR_RAIL')`,
    formIds
  );
  return rows;
};

module.exports = { REQUIRED_EQUIPMENT_TYPES, upsertMany, findByWarrantyFormIds, findById, reviewVerification };
