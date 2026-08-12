const { pool } = require('../config/database');
const AppError = require('../utils/AppError');
const warrantyRepository = require('../repositories/warrantyRepository');
const equipmentRepository = require('../repositories/equipmentRepository');
const productRepository = require('../repositories/productRepository');
const inventoryService = require('./inventoryService');
const pointsService = require('./pointsService');
const easyGasWarrantySyncService = require('./easyGasWarrantySyncService');

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
 * Exception: a CYLINDER row with no product_id is a typed cylinder (free-
 * text brand+model instead of a catalog pick — see the isTypedCylinder
 * branch below) and skips the catalog lookup/barcode/inventory entirely.
 * The other 3 equipment types always go through the catalog path.
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
 *
 * actingUserId: only meaningful when validateBarcodes is true (create) — the
 * submitting employee, needed to verify a Manual Verification photo upload
 * actually belongs to them (see inventoryService.resolveOwnedPhotoFilename).
 * Unused in update mode, where photo ownership is instead checked directly
 * inside updateWarrantyForm's own per-row loop once it knows which rows changed.
 */
const resolveEquipment = async (connection, equipmentInput, { validateBarcodes, actingUserId } = { validateBarcodes: true }) => {
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
    // Typed cylinder: the local catalog can never carry every real-world
    // cylinder in the field, so a cylinder may be entered as free-text
    // brand+capacity instead of a catalog product_id.
    // No product, no barcode, no inventory claim, and 0 points (there's no
    // product to look up a point value for — productPointConfigRepository.
    // getPoints safely returns 0 for a null productId, no special-casing
    // needed). The other 3 equipment types are unaffected and always
    // require a real catalog product_id.
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
        // A typed cylinder has no catalog product and no barcode at all —
        // an entirely different, pre-existing bypass from Manual
        // Verification (see the isTypedCylinder branch above, checked and
        // `continue`d before this point is ever reached). AUTO here simply
        // means "nothing pending review," so it never blocks points —
        // unchanged from how a typed cylinder already behaved before this
        // feature existed.
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

    // Manual Verification workflow — defaults describe "nothing decided
    // yet," which is exactly correct for the update path (validateBarcodes:
    // false): resolveEquipment doesn't validate barcodes there at all
    // (deferred to updateWarrantyForm's per-row changed-only check, same as
    // inventoryItemId below), so these stay at their neutral defaults and
    // updateWarrantyForm's own loop decides the real values afterward.
    let inventoryItemId = null;
    let verificationStatus = 'AUTO';
    let sellerName = null;
    let sellerPhone = null;
    let verificationComment = null;
    let photoFilename = null;

    if (validateBarcodes) {
      if (!row.serial_number) {
        throw new AppError(`A barcode is required for ${row.equipment_type}`, 400, 'BARCODE_REQUIRED');
      }
      // Reuses the exact validateBarcode rule set — it's the only thing that
      // decides AUTO vs PENDING, and it never trusts row.manual_verification
      // as self-certifying: it re-derives the real failure reason itself and
      // only accepts the manual path when that reason is genuinely
      // BARCODE_NOT_FOUND (see inventoryService.validateBarcodeOrAcceptManual).
      const resolution = await inventoryService.validateBarcodeOrAcceptManual(connection, {
        barcode: row.serial_number,
        product,
        equipmentType: row.equipment_type,
        manualVerificationRequested: !!row.manual_verification,
        sellerName: row.seller_name,
        sellerPhone: row.seller_phone,
        comment: row.comment,
        photoFilename: row.manual_verification_photo_filename,
        uploadedBy: actingUserId,
      });
      verificationStatus = resolution.verificationStatus;
      inventoryItemId = resolution.inventoryItemId;
      if (resolution.verificationStatus === 'PENDING') {
        sellerName = resolution.sellerName;
        sellerPhone = resolution.sellerPhone;
        verificationComment = resolution.comment;
        photoFilename = resolution.photoFilename;
      }
    }

    resolved.push({
      equipment_type: row.equipment_type,
      product_id: product.id,
      product_name: `${product.brand} ${product.model || ''}`.trim(),
      brand_name: null,
      model: null,
      serial_number: row.serial_number || null,
      inventory_item_id: inventoryItemId,
      verification_status: verificationStatus,
      seller_name: sellerName,
      seller_phone: sellerPhone,
      verification_comment: verificationComment,
      manual_verification_photo_filename: photoFilename,
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
  // second INSERT. Checked before resolveEquipment/barcode validation so a
  // pure retry does none of that work again and can't double-claim
  // inventory or double-award points.
  const existingFormId = await warrantyRepository.findBySubmissionUuid(connection, data.submission_uuid);
  if (existingFormId) {
    return { formId: existingFormId, created: false };
  }

  const resolvedEquipment = await resolveEquipment(connection, data.equipment, { validateBarcodes: true, actingUserId: employeeId });

  await connection.beginTransaction();
  try {
    // Assigned inside the transaction so a rolled-back submission (e.g. a
    // lost barcode-claim race below) releases its number back rather than
    // leaving a permanent gap — see warrantyRepository.getNextWarrantyNumber.
    const warrantyBookNumber = await warrantyRepository.getNextWarrantyNumber(connection, new Date().getFullYear());
    const formId = await warrantyRepository.insert(connection, employeeId, snapshot, data, warrantyBookNumber);

    // Claim happens here, inside the transaction — every row already has a
    // validated inventory_item_id from resolveEquipment above. A lost race
    // (BARCODE_CLAIM_FAILED) throws and rolls back everything, including
    // the warranty_forms row just inserted and any earlier rows' claims in
    // this same loop (see the Phase 2 plan, section 1).
    for (const row of resolvedEquipment) {
      if (!row.inventory_item_id) continue; // typed cylinder — nothing to claim
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
      // Manual Verification workflow: a row still awaiting admin review has
      // no claimed inventory item and no confirmed identity yet — points are
      // withheld until reviewManualVerification's approve branch awards them
      // explicitly. A rejected row never receives points at all.
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
      // Raw submitted row — needed by both branches below: the "changed"
      // branch already used this for barcode/seller resolution; the
      // "unchanged" branch needs it too now (see the data-loss fix below),
      // so it's looked up once, ahead of the changed/unchanged split.
      const rawRow = (data.equipment || []).find((r) => r.equipment_type === row.equipment_type) || {};

      // model/brand_name only ever differ for a typed cylinder — a no-op
      // comparison for the other 3 types, which always have both null.
      const changed = !existingRow
        || existingRow.product_id !== row.product_id
        || existingRow.serial_number !== row.serial_number
        || existingRow.model !== row.model
        || existingRow.brand_name !== row.brand_name;

      if (!changed) {
        // Unchanged barcode/product — carry over inventory_item_id (possibly
        // NULL, for a historical pre-Phase-2 row) and verification_status
        // exactly as they are: no re-validation, no release, no claim, no
        // points change, no review outcome disturbed just because a SIBLING
        // row on the same warranty changed.
        //
        // Seller info/photo are a genuinely separate, always-editable
        // surface from the barcode/product identity above — an installer
        // must be able to fix a seller-phone typo or attach a photo without
        // also having to change the barcode (this used to force-overwrite
        // whatever was just submitted with the old stored value, silently
        // discarding the edit — see the Manual Verification review fix).
        // Refreshed from the raw submission whenever the row is still
        // flagged for manual verification, validated the same way the
        // "changed" branch below validates it via SELLER_INFO_REQUIRED; if
        // the client isn't flagging this row as manual verification at all
        // (e.g. an old cached form state), the previously-stored values
        // simply survive untouched, same as before this fix.
        row.inventory_item_id = existingRow.inventory_item_id;
        row.verification_status = existingRow.verification_status;
        if (rawRow.manual_verification) {
          if (!rawRow.seller_name?.trim() || !rawRow.seller_phone?.trim() || !rawRow.comment?.trim()) {
            throw new AppError(`Seller name, seller phone, and a comment are required for manual verification of ${row.equipment_type}`, 400, 'SELLER_INFO_REQUIRED');
          }
          row.seller_name = String(rawRow.seller_name).trim();
          row.seller_phone = String(rawRow.seller_phone).trim();
          row.verification_comment = String(rawRow.comment).trim();
          row.manual_verification_photo_filename = await inventoryService.resolveOwnedPhotoFilename(connection, rawRow.manual_verification_photo_filename, userId);
        } else {
          row.seller_name = existingRow.seller_name;
          row.seller_phone = existingRow.seller_phone;
          row.verification_comment = existingRow.verification_comment;
          row.manual_verification_photo_filename = existingRow.manual_verification_photo_filename;
        }
        continue;
      }
      changedTypes.add(row.equipment_type);

      const isTypedCylinder = row.equipment_type === 'CYLINDER' && !row.product_id;
      if (isTypedCylinder) {
        // No barcode/inventory/product involved — just release whatever the
        // OLD assignment held (covers a catalog cylinder being retyped as
        // free text) and reverse its points; a fresh award below (0 points,
        // see resolveEquipment) replaces it.
        if (existingRow && existingRow.inventory_item_id) {
          await inventoryService.releaseForEquipmentRow(connection, {
            itemId: existingRow.inventory_item_id,
            changedBy: userId,
            reason: 'warranty_updated_reassigned',
          });
        }
        if (existingRow) {
          await pointsService.reverseForEquipmentRow(connection, {
            warrantyFormId: formId,
            warrantyEquipmentId: existingRow.id,
            reason: 'warranty_updated_reassigned',
            createdBy: userId,
          });
        }
        row.inventory_item_id = null;
        // Same reasoning as resolveEquipment's typed-cylinder branch — this
        // path is unrelated to Manual Verification, so it always reads as
        // AUTO ("nothing pending review").
        row.verification_status = 'AUTO';
        row.seller_name = null;
        row.seller_phone = null;
        row.verification_comment = null;
        row.manual_verification_photo_filename = null;
        continue;
      }

      // Changed — validate the new barcode now, authoritatively, inside the
      // tx/lock (not pre-transaction, unlike create — see resolveEquipment).
      // Uses the raw submitted row (not the already-resolved one) for the
      // manual-verification fields — resolveEquipment discards them for the
      // update path, since deciding AUTO vs PENDING for a changed row is
      // this loop's job, not resolveEquipment's (see its doc comment).
      if (!row.serial_number) {
        throw new AppError(`A barcode is required for ${row.equipment_type}`, 400, 'BARCODE_REQUIRED');
      }
      const product = await productRepository.findById(connection, row.product_id);
      const resolution = await inventoryService.validateBarcodeOrAcceptManual(connection, {
        barcode: row.serial_number,
        product,
        equipmentType: row.equipment_type,
        manualVerificationRequested: !!rawRow.manual_verification,
        sellerName: rawRow.seller_name,
        sellerPhone: rawRow.seller_phone,
        comment: rawRow.comment,
        photoFilename: rawRow.manual_verification_photo_filename,
        uploadedBy: userId,
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
      // legacy warranty missing this slot) has nothing to reverse. A
      // previously-PENDING or -REJECTED row never had points awarded in the
      // first place, so this is a safe no-op for it (see
      // pointsService.reverseForEquipmentRow's own net===0 guard).
      if (existingRow) {
        await pointsService.reverseForEquipmentRow(connection, {
          warrantyFormId: formId,
          warrantyEquipmentId: existingRow.id,
          reason: 'warranty_updated_reassigned',
          createdBy: userId,
        });
      }

      row.verification_status = resolution.verificationStatus;
      if (resolution.verificationStatus === 'PENDING') {
        // Manual Verification workflow — no item to claim; pending admin
        // review, same as the create path.
        row.inventory_item_id = null;
        row.seller_name = resolution.sellerName;
        row.seller_phone = resolution.sellerPhone;
        row.verification_comment = resolution.comment;
        row.manual_verification_photo_filename = resolution.photoFilename;
      } else {
        await inventoryService.claimForEquipmentRow(connection, {
          itemId: resolution.inventoryItemId,
          productId: row.product_id,
          changedBy: userId,
          reason: 'warranty_updated_reassigned',
        });
        row.inventory_item_id = resolution.inventoryItemId;
        row.seller_name = null;
        row.seller_phone = null;
        row.verification_comment = null;
        row.manual_verification_photo_filename = null;
      }
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
        // Manual Verification workflow: withheld until admin approval,
        // same guard as createWarrantyForm.
        if (row.verification_status === 'PENDING') continue;
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
 * Manual Verification workflow — the admin review action. Same shape as
 * registrationRequestController's approve/reject: read, guard the write on
 * the row's current state, and only do the associated side effect
 * (award points / block sync) once that guarded write actually succeeds.
 *
 * Addressed by the equipment row's own id, not by (formId, equipmentType) —
 * a review always targets exactly one row directly. `decision` is
 * 'APPROVED' or 'REJECTED', validated here rather than trusted from the
 * controller. Acquires the SAME warrantyRepository.lockForm row lock
 * updateWarrantyForm/deleteWarrantyForm already take on the parent warranty,
 * so a concurrent edit/delete of that warranty can never interleave with a
 * review of one of its rows (see Critical Review #11).
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
 * Warranty status workflow — the admin review action, one level up from
 * reviewManualVerification above (that one reviews a single equipment
 * row's barcode identity; this one reviews the warranty form itself, a
 * completely separate concept — see the design notes this feature was
 * built from for why the two are deliberately kept apart).
 *
 * `decision` is 'SUCCESSFUL' or 'REJECTED', validated here rather than
 * trusted from the controller — mirrors reviewManualVerification exactly.
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
  reviewManualVerification,
  reviewWarrantyForm,
  deleteWarrantyForm,
  EDIT_WINDOW_HOURS,
};
