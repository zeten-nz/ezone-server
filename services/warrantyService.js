const { pool } = require('../config/database');
const AppError = require('../utils/AppError');
const warrantyRepository = require('../repositories/warrantyRepository');
const equipmentRepository = require('../repositories/equipmentRepository');
const productRepository = require('../repositories/productRepository');
const pointsService = require('./pointsService');
const easyGasWarrantySyncService = require('./easyGasWarrantySyncService');

const { REQUIRED_EQUIPMENT_TYPES, ALL_EQUIPMENT_TYPES } = equipmentRepository;
const EDIT_WINDOW_HOURS = 24;

const getEmployeeSnapshot = (connection, employeeId) => warrantyRepository.getEmployeeSnapshot(connection, employeeId);

/**
 * TEMPORARY PRODUCT DECISION (barcode/inventory verification disabled):
 * warranty submission no longer validates a component's serial number
 * against the local inventory/barcode system, no longer claims inventory
 * items, and no longer offers the Manual Verification fallback. The serial
 * number itself REMAINS a required part of each catalog-product component
 * (it is stored on warranty_equipment.serial_number and sent to EasyGas in
 * components[].serial_number — see easyGasWarrantySyncService.buildComponent);
 * only the local-inventory verification of it is disabled. The standalone
 * Inventory module (services/inventoryService.js) is untouched and keeps
 * working independently — it is simply no longer wired into this workflow.
 * Historical columns (warranty_equipment.inventory_item_id,
 * verification_status, seller_*, verification_comment,
 * manual_verification_photo_filename) are preserved and still readable;
 * new submissions write verification_status='AUTO' ("nothing pending
 * review", the pre-existing default) with the rest NULL.
 */

/**
 * Resolves each submitted equipment row's product_id into a full catalog
 * record — product_name is always server-derived here, never accepted from
 * the client (a client-supplied name could corrupt the category/brand
 * groupings Reports' "Products Installed" view depends on). Also validates
 * the submitted set is exactly the 4 required types, each exactly once —
 * the DB's UNIQUE(warranty_form_id, equipment_type) constraint guards
 * against duplicates but can't by itself guarantee completeness.
 *
 * Exception: a CYLINDER row with no product_id is a typed cylinder (free-
 * text brand+model instead of a catalog pick — see the isTypedCylinder
 * branch below) and has no serial-number requirement, matching its
 * pre-existing behavior. The other 3 equipment types always go through the
 * catalog path.
 *
 * requireSerials:
 *   - true  (create): every catalog-product row must carry a serial number
 *     (the value formerly doubling as the inventory barcode — same field,
 *     the inventory lookup is just no longer performed).
 *   - false (update): serial presence is only enforced for rows that
 *     actually CHANGED, decided inside updateWarrantyForm's own per-row
 *     loop after the same-warranty lock — a legacy row with no serial must
 *     remain editable-around (an unchanged row is carried over untouched).
 */
const resolveEquipment = async (connection, equipmentInput, { requireSerials } = { requireSerials: true }) => {
  const rows = Array.isArray(equipmentInput) ? equipmentInput : [];
  const types = rows.map((r) => r.equipment_type);
  const uniqueTypes = new Set(types);
  // Beta-3 invariant: REDUCER/CONTROLLER/INJECTOR_RAIL each exactly once;
  // CYLINDER zero-or-one; nothing else, no duplicates of anything. A valid
  // set is therefore 3 or 4 rows — never trust the count alone.
  const isValid = uniqueTypes.size === types.length                         // no duplicates (incl. duplicate CYLINDER)
    && types.every((t) => ALL_EQUIPMENT_TYPES.includes(t))                  // no unknown types
    && REQUIRED_EQUIPMENT_TYPES.every((t) => uniqueTypes.has(t));           // all three required present
  if (!isValid) {
    throw new AppError('Reducer, controller and injector rail are each required exactly once; cylinder is optional', 400, 'EQUIPMENT_INCOMPLETE');
  }

  const resolved = [];
  for (const row of rows) {
    // Typed cylinder: the local catalog can never carry every real-world
    // cylinder in the field, so a cylinder may be entered as free-text
    // brand+capacity instead of a catalog product_id. No product and 0
    // points via product config (equipmentTypePointConfigRepository's
    // per-type value covers it instead — see pointsService).
    const isTypedCylinder = row.equipment_type === 'CYLINDER' && !row.product_id;
    if (isTypedCylinder) {
      if (!row.model || !String(row.model).trim()) {
        throw new AppError('A model/capacity is required for a typed cylinder', 400, 'CYLINDER_MODEL_REQUIRED');
      }
      const brandName = row.brand_name ? String(row.brand_name).trim() : null;
      const model = String(row.model).trim();
      resolved.push({
        equipment_type: 'CYLINDER',
        product_id: null,
        product_name: brandName ? `${brandName} ${model}` : model,
        brand_name: brandName,
        model,
        serial_number: row.serial_number || null,
        inventory_item_id: null,
        // AUTO simply means "nothing pending review" — the pre-existing
        // default, and the only value new submissions ever write now that
        // Manual Verification is disabled.
        verification_status: 'AUTO',
        seller_name: null,
        seller_phone: null,
        verification_comment: null,
        manual_verification_photo_filename: null,
      });
      continue;
    }

    const product = await productRepository.findById(connection, row.product_id);
    if (!product) {
      throw new AppError(`Product not found for ${row.equipment_type}`, 404, 'PRODUCT_NOT_FOUND');
    }
    if (!product.is_active) {
      throw new AppError(`Selected ${row.equipment_type} product is no longer active`, 409, 'PRODUCT_INACTIVE');
    }

    // Serial number stays required (it is stored and sent to EasyGas) —
    // but it is NO LONGER looked up in inventory: submission must not fail
    // because a barcode is unknown, not IN_STOCK, or belongs elsewhere.
    // errorCode kept as BARCODE_REQUIRED so existing clients' localized
    // error mapping keeps working unchanged.
    if (requireSerials && !row.serial_number) {
      throw new AppError(`A serial number is required for ${row.equipment_type}`, 400, 'BARCODE_REQUIRED');
    }

    resolved.push({
      equipment_type: row.equipment_type,
      product_id: product.id,
      product_name: `${product.brand} ${product.model || ''}`.trim(),
      brand_name: null,
      model: null,
      serial_number: row.serial_number || null,
      inventory_item_id: null,
      verification_status: 'AUTO',
      seller_name: null,
      seller_phone: null,
      verification_comment: null,
      manual_verification_photo_filename: null,
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

  // Idempotent create: the frontend generates submission_uuid once and
  // reuses it on every retry (see routes/warrantyRoutes.js) — a retried
  // POST (e.g. after a client-side timeout on a request that actually
  // succeeded) must return the already-created form, never attempt a
  // second INSERT. Checked before resolveEquipment so a pure retry does
  // none of that work again and can't double-award points.
  const existingFormId = await warrantyRepository.findBySubmissionUuid(connection, data.submission_uuid);
  if (existingFormId) {
    return { formId: existingFormId, created: false };
  }

  const resolvedEquipment = await resolveEquipment(connection, data.equipment, { requireSerials: true });

  await connection.beginTransaction();
  try {
    // Assigned inside the transaction so a rolled-back submission releases
    // its number back rather than leaving a permanent gap — see
    // warrantyRepository.getNextWarrantyNumber.
    const warrantyBookNumber = await warrantyRepository.getNextWarrantyNumber(connection, new Date().getFullYear());
    const formId = await warrantyRepository.insert(connection, employeeId, snapshot, data, warrantyBookNumber);

    // No inventory claim happens here anymore — see the TEMPORARY PRODUCT
    // DECISION note at the top of this file.

    await equipmentRepository.upsertMany(connection, formId, resolvedEquipment);

    // Points are awarded after upsertMany, not before — warranty_equipment.id
    // doesn't exist until upsertMany inserts the rows, and the ledger needs
    // that id. findByWarrantyFormIds re-reads what was just written to get
    // each row's real id and product_id together. Every new row is AUTO, so
    // every row awards immediately; the PENDING guard remains only as a
    // safety net (no new submission can produce a PENDING row).
    const finalEquipment = await equipmentRepository.findByWarrantyFormIds(connection, [formId]);
    for (const row of finalEquipment) {
      if (row.verification_status === 'PENDING') continue;
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
    return { formId, created: true };
  } catch (error) {
    await connection.rollback();
    // Two near-simultaneous retries can both pass the pre-check above; the
    // loser lands here instead, on the UNIQUE(submission_uuid) constraint.
    // Re-read the winner's row rather than surfacing a raw DB error.
    if (error.code === 'ER_DUP_ENTRY') {
      const winnerFormId = await warrantyRepository.findBySubmissionUuid(connection, data.submission_uuid);
      if (winnerFormId) {
        return { formId: winnerFormId, created: false };
      }
    }
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

  // Product/is_active validated now; serial presence enforced per changed
  // row inside the transaction below — see resolveEquipment's doc comment.
  const resolvedEquipment = await resolveEquipment(connection, data.equipment, { requireSerials: false });

  await connection.beginTransaction();
  try {
    // Serializes concurrent update/delete of THIS warranty — a second
    // concurrent request blocks here until the first commits or rolls back,
    // then re-reads equipment state fresh below, never acting on a stale
    // pre-lock snapshot. Also re-verifies the warranty still exists — it
    // could have been deleted by a concurrent request since the ownership
    // check above.
    const lockedForm = await warrantyRepository.lockForm(connection, formId);
    if (!lockedForm) {
      throw new AppError('Warranty form not found', 404, 'NOT_FOUND');
    }

    const existingEquipment = await equipmentRepository.findByWarrantyFormIds(connection, [formId]);
    const existingByType = new Map(existingEquipment.map((row) => [row.equipment_type, row]));
    const changedTypes = new Set();

    for (const row of resolvedEquipment) {
      const existingRow = existingByType.get(row.equipment_type);

      // model/brand_name only ever differ for a typed cylinder — a no-op
      // comparison for the other 3 types, which always have both null.
      const changed = !existingRow
        || existingRow.product_id !== row.product_id
        || existingRow.serial_number !== row.serial_number
        || existingRow.model !== row.model
        || existingRow.brand_name !== row.brand_name;

      if (!changed) {
        // Unchanged identity — carry over the historical fields exactly as
        // stored (inventory_item_id possibly set by the old claiming flow,
        // verification_status possibly PENDING/APPROVED/REJECTED from the
        // old Manual Verification flow, plus any seller info/photo). No
        // re-validation, no points change, no review outcome disturbed just
        // because a SIBLING row on the same warranty changed. With Manual
        // Verification disabled, seller info is no longer editable — the
        // stored historical values simply survive untouched.
        row.inventory_item_id = existingRow.inventory_item_id;
        row.verification_status = existingRow.verification_status;
        row.seller_name = existingRow.seller_name;
        row.seller_phone = existingRow.seller_phone;
        row.verification_comment = existingRow.verification_comment;
        row.manual_verification_photo_filename = existingRow.manual_verification_photo_filename;
        continue;
      }
      changedTypes.add(row.equipment_type);

      // A changed catalog-product row needs a serial number (same rule as
      // create; a typed cylinder is exempt as before). Deliberately NOT
      // applied to unchanged rows — a legacy row with no serial stays
      // editable-around.
      const isTypedCylinder = row.equipment_type === 'CYLINDER' && !row.product_id;
      if (!isTypedCylinder && !row.serial_number) {
        throw new AppError(`A serial number is required for ${row.equipment_type}`, 400, 'BARCODE_REQUIRED');
      }

      // Inventory is deliberately NOT touched on a changed row — no release
      // of the old item, no claim of a new one (see the TEMPORARY PRODUCT
      // DECISION note). An item claimed by the old flow keeps its INSTALLED
      // status and history; only this row's link to it is cleared below,
      // since the row's identity no longer corresponds to that claim.
      //
      // Points: always reverse-then-reaward on a real change, since the net
      // may move (different product = different configured value). Guarded
      // by `existingRow` existing at all — a genuinely new row (a legacy
      // warranty missing this slot) has nothing to reverse. A previously-
      // PENDING or -REJECTED row never had points awarded in the first
      // place, so this is a safe no-op for it (see
      // pointsService.reverseForEquipmentRow's own net===0 guard).
      if (existingRow) {
        await pointsService.reverseForEquipmentRow(connection, {
          warrantyFormId: formId,
          warrantyEquipmentId: existingRow.id,
          reason: 'warranty_updated_reassigned',
          createdBy: userId,
        });
      }

      row.inventory_item_id = null;
      row.verification_status = 'AUTO';
      row.seller_name = null;
      row.seller_phone = null;
      row.verification_comment = null;
      row.manual_verification_photo_filename = null;
    }

    // Beta-3: optional-cylinder REMOVAL. upsertMany never deletes, so a
    // submitted set without CYLINDER while a CYLINDER row exists means the
    // user removed it: reverse its points FIRST (the ledger's
    // warranty_equipment_id FK is ON DELETE SET NULL — reversing after the
    // delete could no longer find the rows), then delete exactly that one
    // row by its bounded key. All inside this same locked transaction, so a
    // later failure rolls back both. Removing an already-absent cylinder is
    // a natural no-op (no existing row → nothing here runs), so a repeated
    // removal can never double-reverse.
    const submittedTypes = new Set(resolvedEquipment.map((row) => row.equipment_type));
    const removedCylinder = existingByType.get('CYLINDER') && !submittedTypes.has('CYLINDER');
    if (removedCylinder) {
      const cylinderRow = existingByType.get('CYLINDER');
      await pointsService.reverseForEquipmentRow(connection, {
        warrantyFormId: formId,
        warrantyEquipmentId: cylinderRow.id,
        reason: 'warranty_updated_reassigned',
        createdBy: userId,
      });
      await equipmentRepository.deleteByFormAndType(connection, formId, 'CYLINDER');
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
        if (row.verification_status === 'PENDING') continue; // safety net — new rows are always AUTO
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

/**
 * Manual Verification review — HISTORICAL-ONLY admin action. The active
 * warranty workflow can no longer produce a PENDING row (Manual
 * Verification is disabled — see the note at the top of this file), but
 * warranties submitted under the old flow may still hold rows awaiting
 * review, and this remains the only way to resolve them (and release the
 * points that were withheld at their creation). Kept intact so that
 * backlog is never stranded; once no PENDING rows remain in production
 * this endpoint simply never matches anything (the atomic
 * WHERE verification_status='PENDING' guard).
 *
 * Addressed by the equipment row's own id, not by (formId, equipmentType) —
 * a review always targets exactly one row directly. `decision` is
 * 'APPROVED' or 'REJECTED', validated here rather than trusted from the
 * controller. Acquires the SAME warrantyRepository.lockForm row lock
 * updateWarrantyForm/deleteWarrantyForm already take on the parent warranty,
 * so a concurrent edit/delete of that warranty can never interleave with a
 * review of one of its rows.
 */
const reviewManualVerification = async (connection, equipmentId, adminUserId, { decision, notes }) => {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw new AppError('decision must be APPROVED or REJECTED', 400, 'VALIDATION_ERROR');
  }

  const equipmentRow = await equipmentRepository.findById(connection, equipmentId);
  if (!equipmentRow) {
    throw new AppError('Equipment row not found', 404, 'NOT_FOUND');
  }
  // The warranty's OWNING employee, not adminUserId — points are always
  // credited to whoever installed the equipment, never to the reviewer
  // (same rule updateWarrantyForm's reaward loop already follows).
  const ownership = await warrantyRepository.findOwnershipInfo(connection, equipmentRow.warranty_form_id);
  if (!ownership) {
    throw new AppError('Warranty form not found', 404, 'NOT_FOUND');
  }

  await connection.beginTransaction();
  try {
    const lockedForm = await warrantyRepository.lockForm(connection, equipmentRow.warranty_form_id);
    if (!lockedForm) {
      throw new AppError('Warranty form not found', 404, 'NOT_FOUND');
    }

    // Atomic guard: WHERE verification_status = 'PENDING'. A duplicate
    // review request, or two admins reviewing the same row concurrently,
    // affects 0 rows the second time — never re-reviews, and critically,
    // never double-awards points.
    const reviewed = await equipmentRepository.reviewVerification(connection, {
      equipmentId,
      decision,
      reviewedBy: adminUserId,
      notes,
    });
    if (!reviewed) {
      throw new AppError('This equipment row has already been reviewed', 409, 'INVALID_STATE');
    }

    // A REJECTED row simply never earns points — no further action needed:
    // its verification_status alone (already flipped by reviewVerification
    // above) is what excludes it from every "confirmed installed" count
    // reports/statistics already key off (see reportsController.js).
    if (decision === 'APPROVED') {
      await pointsService.awardForEquipmentRow(connection, {
        installerId: ownership.employee_id,
        warrantyFormId: equipmentRow.warranty_form_id,
        warrantyEquipmentId: equipmentId,
        productId: equipmentRow.product_id,
        equipmentType: equipmentRow.equipment_type,
        productLabel: equipmentRow.product_name,
        createdBy: adminUserId,
      });
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
};

/**
 * Warranty status workflow — the admin review action on the warranty form
 * itself (PENDING -> SUCCESSFUL/REJECTED), a completely separate concept
 * from reviewManualVerification above.
 *
 * `decision` is 'SUCCESSFUL' or 'REJECTED', validated here rather than
 * trusted from the controller.
 *
 * EasyGas sync is triggered AFTER this function's own transaction commits,
 * never inside it: a network call must never hold a DB connection/lock
 * open. It only fires when reviewForm's atomic guard actually flips
 * PENDING -> SUCCESSFUL (never on REJECTED, never on a request that loses
 * a concurrency race — see warrantyRepository.reviewForm), which is what
 * guarantees "never before, never twice" end to end. A sync failure is
 * recorded (see easyGasWarrantySyncService) but never re-throws — the
 * admin's approval already committed successfully and must not appear to
 * fail just because EasyGas was unreachable.
 */
const reviewWarrantyForm = async (connection, formId, adminUserId, { decision, notes }) => {
  if (!['SUCCESSFUL', 'REJECTED'].includes(decision)) {
    throw new AppError('decision must be SUCCESSFUL or REJECTED', 400, 'VALIDATION_ERROR');
  }

  await connection.beginTransaction();
  try {
    const lockedForm = await warrantyRepository.lockForm(connection, formId);
    if (!lockedForm) {
      throw new AppError('Warranty form not found', 404, 'NOT_FOUND');
    }

    const reviewed = await warrantyRepository.reviewForm(connection, {
      formId,
      decision,
      reviewedBy: adminUserId,
      notes,
    });
    if (!reviewed) {
      throw new AppError('This warranty form has already been reviewed', 409, 'INVALID_STATE');
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }

  if (decision === 'SUCCESSFUL') {
    await easyGasWarrantySyncService.syncWarrantyForm(pool, formId);
  }
};

const deleteWarrantyForm = async (connection, formId, actingUserId) => {
  await connection.beginTransaction();
  try {
    // Same same-warranty lock as update.
    const lockedForm = await warrantyRepository.lockForm(connection, formId);
    if (!lockedForm) {
      throw new AppError('Warranty form not found', 404, 'NOT_FOUND');
    }

    // Must read equipment rows BEFORE deleteById's cascade removes them —
    // their ids are needed for the point reversals below. Inventory is
    // deliberately NOT touched (see the TEMPORARY PRODUCT DECISION note):
    // an item claimed by the old flow keeps its INSTALLED status and
    // history; releasing it back to stock is an explicit manual inventory
    // operation now, never a warranty-delete side effect.
    const equipmentRows = await equipmentRepository.findByWarrantyFormIds(connection, [formId]);
    for (const row of equipmentRows) {
      // Reverses whatever points are outstanding for every row
      // unconditionally — a historical row that never earned points simply
      // no-ops (see pointsService.reverseForEquipmentRow's net===0 guard).
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

/**
 * Auto-submit a newly-created warranty to EasyGas (admin approval no longer exists for new warranties). Called by the
 * controller AFTER createWarrantyForm has committed AND its create connection has been released — never during the
 * create transaction (no DB lock/transaction is held during the external HTTP call). Delegates to the exact same
 * fire-and-forget sync the (now historical-only) admin-approval path uses: syncWarrantyForm records SUCCESS/FAILED +
 * claim_url on the row and NEVER rolls back the committed warranty. The caller invokes this ONLY when a warranty was
 * actually created (created === true), so an idempotent submission_uuid retry never triggers a second EasyGas POST.
 */
const submitWarrantyToEasyGas = (formId) => easyGasWarrantySyncService.syncWarrantyForm(pool, formId);

module.exports = {
  getEmployeeSnapshot,
  resolveEquipment,
  createWarrantyForm,
  submitWarrantyToEasyGas,
  updateWarrantyForm,
  reviewManualVerification,
  reviewWarrantyForm,
  deleteWarrantyForm,
  EDIT_WINDOW_HOURS,
};
