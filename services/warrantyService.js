const AppError = require('../utils/AppError');
const warrantyRepository = require('../repositories/warrantyRepository');
const equipmentRepository = require('../repositories/equipmentRepository');
const productRepository = require('../repositories/productRepository');
const inventoryService = require('./inventoryService');
const pointsService = require('./pointsService');

const { REQUIRED_EQUIPMENT_TYPES } = equipmentRepository;
const EDIT_WINDOW_HOURS = 24;

const getEmployeeSnapshot = (connection, employeeId) => warrantyRepository.getEmployeeSnapshot(connection, employeeId);

/**
 * Resolves each submitted equipment row's product_id into a full catalog
 * record — product_name is always server-derived here, never accepted from
 * the client (a client-supplied name could corrupt the category/brand
 * groupings Reports' "Products Installed" view depends on). Also validates
 * the submitted set is exactly the 4 required types, each exactly once —
 * the DB's UNIQUE(warranty_form_id, equipment_type) constraint guards
 * against duplicates but can't by itself guarantee completeness.
 *
 * validateBarcodes (Phase 2) controls whether each row's barcode
 * (serial_number IS the barcode — see the Phase 2 plan's Design Decision 2,
 * they're the same value, not two fields) is also validated against real
 * inventory right now:
 *   - true  (create): every row needs a barcode that resolves to a real,
 *     claimable IN_STOCK item — nothing existing to race against yet, so
 *     this can safely run before any transaction opens, same as the
 *     product checks already did.
 *   - false (update): barcode validation is deliberately deferred to
 *     inside updateWarrantyForm's transaction. An *unchanged* row's item is
 *     currently INSTALLED — correctly, by this very warranty — so running
 *     the same "must be IN_STOCK" check against it here would wrongly
 *     reject it. Only rows that actually changed need validating, and that
 *     can only be decided safely from a read taken *after* the same-warranty
 *     lock (warrantyRepository.lockForm) is acquired — seeing Critical
 *     Review #11 in the Phase 2 plan for the concurrency reasoning.
 *
 * When validateBarcodes is true, each resolved row's `inventory_item_id` is
 * already populated (from the item validateBarcode found) — update fills
 * this in separately, per row, once it knows which rows actually changed.
 */
const resolveEquipment = async (connection, equipmentInput, { validateBarcodes } = { validateBarcodes: true }) => {
  const rows = Array.isArray(equipmentInput) ? equipmentInput : [];
  const types = rows.map((r) => r.equipment_type);
  const uniqueTypes = new Set(types);
  const isComplete = rows.length === REQUIRED_EQUIPMENT_TYPES.length
    && uniqueTypes.size === REQUIRED_EQUIPMENT_TYPES.length
    && REQUIRED_EQUIPMENT_TYPES.every((t) => uniqueTypes.has(t));
  if (!isComplete) {
    throw new AppError('All 4 equipment types are required, each exactly once', 400, 'EQUIPMENT_INCOMPLETE');
  }

  const resolved = [];
  for (const row of rows) {
    const product = await productRepository.findById(connection, row.product_id);
    if (!product) {
      throw new AppError(`Product not found for ${row.equipment_type}`, 404, 'PRODUCT_NOT_FOUND');
    }
    if (!product.is_active) {
      throw new AppError(`Selected ${row.equipment_type} product is no longer active`, 409, 'PRODUCT_INACTIVE');
    }

    let inventoryItemId = null;
    if (validateBarcodes) {
      if (!row.serial_number) {
        throw new AppError(`A barcode is required for ${row.equipment_type}`, 400, 'BARCODE_REQUIRED');
      }
      const item = await inventoryService.validateBarcode(connection, {
        barcode: row.serial_number,
        product,
        equipmentType: row.equipment_type,
      });
      inventoryItemId = item.id;
    }

    resolved.push({
      equipment_type: row.equipment_type,
      product_id: product.id,
      product_name: `${product.brand} ${product.model || ''}`.trim(),
      serial_number: row.serial_number || null,
      inventory_item_id: inventoryItemId,
    });
  }
  return resolved;
};

const createWarrantyForm = async (connection, employeeId, data) => {
  const snapshot = await getEmployeeSnapshot(connection, employeeId);
  if (!snapshot) {
    throw new AppError(
      'Your profile is missing branch information — ask an admin to assign your branch',
      400,
      'INCOMPLETE_PROFILE'
    );
  }
  const resolvedEquipment = await resolveEquipment(connection, data.equipment, { validateBarcodes: true });

  await connection.beginTransaction();
  try {
    const formId = await warrantyRepository.insert(connection, employeeId, snapshot, data);

    // Claim happens here, inside the transaction — every row already has a
    // validated inventory_item_id from resolveEquipment above. A lost race
    // (BARCODE_CLAIM_FAILED) throws and rolls back everything, including
    // the warranty_forms row just inserted and any earlier rows' claims in
    // this same loop (see the Phase 2 plan, section 1).
    for (const row of resolvedEquipment) {
      await inventoryService.claimForEquipmentRow(connection, {
        itemId: row.inventory_item_id,
        productId: row.product_id,
        changedBy: employeeId,
      });
    }

    await equipmentRepository.upsertMany(connection, formId, resolvedEquipment);

    // Points are awarded after upsertMany, not interleaved with the claim
    // loop above — warranty_equipment.id doesn't exist until upsertMany
    // inserts the rows, and the ledger needs that id (see the Phase 3 plan's
    // Critical Review #4). findByWarrantyFormIds re-reads what was just
    // written to get each row's real id and product_id together.
    const finalEquipment = await equipmentRepository.findByWarrantyFormIds(connection, [formId]);
    for (const row of finalEquipment) {
      await pointsService.awardForEquipmentRow(connection, {
        installerId: employeeId,
        warrantyFormId: formId,
        warrantyEquipmentId: row.id,
        productId: row.product_id,
        equipmentType: row.equipment_type,
        productLabel: row.product_name,
        createdBy: employeeId,
      });
    }

    await connection.commit();
    return formId;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
};

const updateWarrantyForm = async (connection, formId, userId, role, data) => {
  const existing = await warrantyRepository.findOwnershipInfo(connection, formId);
  if (!existing) {
    throw new AppError('Warranty form not found', 404, 'NOT_FOUND');
  }
  if (role !== 'ADMIN') {
    if (existing.employee_id !== userId) {
      throw new AppError('Access denied', 403, 'FORBIDDEN');
    }
    const hoursElapsed = (Date.now() - new Date(existing.created_at).getTime()) / 3_600_000;
    if (hoursElapsed > EDIT_WINDOW_HOURS) {
      throw new AppError('Forms can only be edited within 24 hours of submission', 403, 'EDIT_WINDOW_EXPIRED');
    }
  }

  // Product/is_active validated now; barcode validation deferred — see
  // resolveEquipment's doc comment above.
  const resolvedEquipment = await resolveEquipment(connection, data.equipment, { validateBarcodes: false });

  await connection.beginTransaction();
  try {
    // Serializes concurrent update/delete of THIS warranty (Critical Review
    // #11) — a second concurrent request blocks here until the first
    // commits or rolls back, then re-reads equipment state fresh below,
    // never acting on a stale pre-lock snapshot. Also re-verifies the
    // warranty still exists — it could have been deleted by a concurrent
    // request since the ownership check above.
    const lockedForm = await warrantyRepository.lockForm(connection, formId);
    if (!lockedForm) {
      throw new AppError('Warranty form not found', 404, 'NOT_FOUND');
    }

    const existingEquipment = await equipmentRepository.findByWarrantyFormIds(connection, [formId]);
    const existingByType = new Map(existingEquipment.map((row) => [row.equipment_type, row]));
    const changedTypes = new Set();

    for (const row of resolvedEquipment) {
      const existingRow = existingByType.get(row.equipment_type);
      const changed = !existingRow
        || existingRow.product_id !== row.product_id
        || existingRow.serial_number !== row.serial_number;

      if (!changed) {
        // Unchanged — carry over whatever inventory_item_id (possibly NULL,
        // for a historical pre-Phase-2 row) already exists. No validation,
        // no release, no claim, no points change.
        row.inventory_item_id = existingRow.inventory_item_id;
        continue;
      }
      changedTypes.add(row.equipment_type);

      // Changed — validate the new barcode now, authoritatively, inside the
      // tx/lock (not pre-transaction, unlike create — see resolveEquipment).
      if (!row.serial_number) {
        throw new AppError(`A barcode is required for ${row.equipment_type}`, 400, 'BARCODE_REQUIRED');
      }
      const product = await productRepository.findById(connection, row.product_id);
      const item = await inventoryService.validateBarcode(connection, {
        barcode: row.serial_number,
        product,
        equipmentType: row.equipment_type,
      });

      if (existingRow && existingRow.inventory_item_id) {
        await inventoryService.releaseForEquipmentRow(connection, {
          itemId: existingRow.inventory_item_id,
          changedBy: userId,
          reason: 'warranty_updated_reassigned',
        });
      }
      // Reverse whatever points were outstanding on the OLD assignment for
      // this row — always reverse-then-reaward on a real change, even when
      // the net won't move (e.g. same product, different physical barcode),
      // since this is the same "did this row change" trigger that drives
      // inventory release/claim (see the Phase 3 plan's Critical Review #5).
      // Guarded by `existingRow` existing at all — a genuinely new row (a
      // legacy warranty missing this slot) has nothing to reverse.
      if (existingRow) {
        await pointsService.reverseForEquipmentRow(connection, {
          warrantyFormId: formId,
          warrantyEquipmentId: existingRow.id,
          reason: 'warranty_updated_reassigned',
          createdBy: userId,
        });
      }
      await inventoryService.claimForEquipmentRow(connection, {
        itemId: item.id,
        productId: row.product_id,
        changedBy: userId,
        reason: 'warranty_updated_reassigned',
      });
      row.inventory_item_id = item.id;
    }

    await warrantyRepository.update(connection, formId, data);
    await equipmentRepository.upsertMany(connection, formId, resolvedEquipment);

    // Reaward changed rows only — same sequencing reason as create (row.id
    // isn't guaranteed stable/known until after upsertMany). Credits the
    // warranty's OWNER (existing.employee_id), not `userId` — an admin
    // editing someone else's warranty must not steal their points.
    if (changedTypes.size > 0) {
      const finalEquipment = await equipmentRepository.findByWarrantyFormIds(connection, [formId]);
      for (const row of finalEquipment) {
        if (!changedTypes.has(row.equipment_type)) continue;
        await pointsService.awardForEquipmentRow(connection, {
          installerId: existing.employee_id,
          warrantyFormId: formId,
          warrantyEquipmentId: row.id,
          productId: row.product_id,
          equipmentType: row.equipment_type,
          productLabel: row.product_name,
          createdBy: userId,
        });
      }
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
};

const deleteWarrantyForm = async (connection, formId, actingUserId) => {
  await connection.beginTransaction();
  try {
    // Same same-warranty lock as update — see Critical Review #11.
    const lockedForm = await warrantyRepository.lockForm(connection, formId);
    if (!lockedForm) {
      throw new AppError('Warranty form not found', 404, 'NOT_FOUND');
    }

    // Must read equipment rows BEFORE deleteById's cascade removes them —
    // their inventory_item_id values are only recoverable here.
    const equipmentRows = await equipmentRepository.findByWarrantyFormIds(connection, [formId]);
    for (const row of equipmentRows) {
      if (row.inventory_item_id) {
        await inventoryService.releaseForEquipmentRow(connection, {
          itemId: row.inventory_item_id,
          changedBy: actingUserId,
          reason: 'warranty_deleted',
        });
      }
      // Reverses whatever points are outstanding for every row unconditionally
      // (not gated on inventory_item_id, unlike the release above) — points
      // and inventory claims are related but not identical gates; a
      // historical row that never earned points simply no-ops (see the
      // Phase 3 plan's Critical Review #6). No installer lookup needed here
      // either — reverseForEquipmentRow derives it from the ledger itself.
      await pointsService.reverseForEquipmentRow(connection, {
        warrantyFormId: formId,
        warrantyEquipmentId: row.id,
        reason: 'warranty_deleted',
        createdBy: actingUserId,
      });
    }

    await warrantyRepository.deleteById(connection, formId);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
};

module.exports = {
  getEmployeeSnapshot,
  resolveEquipment,
  createWarrantyForm,
  updateWarrantyForm,
  deleteWarrantyForm,
  EDIT_WINDOW_HOURS,
};
