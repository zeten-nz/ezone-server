const inventoryRepository = require('../repositories/inventoryRepository');
const inventoryImportBatchRepository = require('../repositories/inventoryImportBatchRepository');
const inventoryAuditLogRepository = require('../repositories/inventoryAuditLogRepository');
const manualVerificationUploadRepository = require('../repositories/manualVerificationUploadRepository');
const productRepository = require('../repositories/productRepository');
const AppError = require('../utils/AppError');
const { EQUIPMENT_TYPE_TO_CATEGORIES } = require('../config/equipmentCategories');
const { extractBarcodeCandidates } = require('../utils/csvBarcodeParser');

const isValidBarcode = (line) => /^[A-Za-z0-9-]+$/.test(line);

/**
 * Imports a CSV of bare barcodes for one product.
 *
 * "Transactional" here means one commit/rollback boundary for the whole
 * import, not all-or-nothing per row: duplicate/error rows are classified
 * BEFORE any insert is attempted (they're not SQL failures), so they don't
 * need a rollback — only a genuine mid-import failure (e.g. a dropped DB
 * connection) rolls back, leaving nothing partially committed. The caller
 * owns the actual transaction (begin/commit/rollback), matching
 * warrantyService's convention — this function just does the work inside it.
 *
 * Reports four counts: `imported` (new barcodes actually inserted),
 * `duplicates` (already existed, either in the DB or repeated within this
 * same file), `errors` (malformed after trimming), and `skipped` as a
 * rollup (`duplicates + errors` — total rows that did NOT get imported).
 */
const importCsv = async (connection, { productId, buffer, uploadedBy, fileName, branchId }) => {
  const product = await productRepository.findById(connection, productId);
  if (!product) {
    throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  }

  // csv-parse/sync can throw synchronously on genuinely malformed input
  // (e.g. an unbalanced quote) — the old line-splitter never threw here, so
  // this is wrapped and surfaced as a clean 400 instead of an unhandled 500;
  // importInventory's existing rollback/next(error) chain forwards it correctly.
  let dataLines;
  try {
    dataLines = extractBarcodeCandidates(buffer);
  } catch (error) {
    throw new AppError(`The uploaded file could not be parsed as CSV: ${error.message}`, 400, 'CSV_PARSE_ERROR');
  }

  const seenInFile = new Set();
  let duplicatesInFile = 0;
  let errorCount = 0;
  const candidates = [];
  for (const line of dataLines) {
    if (!isValidBarcode(line)) {
      errorCount += 1;
      continue;
    }
    if (seenInFile.has(line)) {
      duplicatesInFile += 1;
      continue;
    }
    seenInFile.add(line);
    candidates.push(line);
  }

  const existing = await inventoryRepository.findExistingBarcodes(connection, candidates);
  const newBarcodes = candidates.filter((barcode) => !existing.has(barcode));
  const duplicateCount = duplicatesInFile + existing.size;
  const skippedCount = duplicateCount + errorCount;

  // All the counts are already known before any row is written, so the
  // batch record is created first and its id stamped directly onto the
  // bulk insert — no follow-up UPDATE needed.
  const batchId = await inventoryImportBatchRepository.create(connection, {
    productId,
    uploadedBy,
    fileName,
    totalRows: dataLines.length,
    importedCount: newBarcodes.length,
    skippedCount,
    duplicateCount,
    errorCount,
  });

  let newItemIds = [];
  if (newBarcodes.length > 0) {
    await inventoryRepository.bulkInsert(connection, { productId, barcodes: newBarcodes, importBatchId: batchId, branchId: branchId || null });
    // Phase 2 requirement: "Imported" must leave history too, alongside the
    // claim/release transitions Phase 2 adds — see the Phase 2 plan's
    // Design Decision D. bulkInsert doesn't return generated ids, so the
    // freshly-inserted rows are looked up by (product_id, barcode) — cheap,
    // and correct even under concurrent imports since barcode is globally
    // UNIQUE (no other import could have produced the same rows).
    newItemIds = await inventoryRepository.findIdsByBarcodes(connection, { productId, barcodes: newBarcodes });
    await inventoryRepository.bulkInsertStatusHistory(connection, {
      itemIds: newItemIds,
      toStatus: 'IN_STOCK',
      changedBy: uploadedBy,
      reason: `csv_import_batch_${batchId}`,
    });
  }

  return {
    batchId,
    imported: newBarcodes.length,
    skipped: skippedCount,
    duplicates: duplicateCount,
    errors: errorCount,
    total: dataLines.length,
  };
};

/**
 * Read-only — the single, shared rule set for "is this barcode usable for
 * this product/equipment slot right now." Called from both the instant-
 * feedback GET /api/inventory/validate/:barcode endpoint and
 * warrantyService.resolveEquipment (pre-transaction, authoritative) — never
 * duplicated, so the two can't drift (see Phase 2 plan, Design Decision A).
 * Takes an already-resolved `product` (both callers either already have one
 * or fetch it once) rather than a bare productId, to avoid a second lookup.
 * This is explicitly NOT the enforcement mechanism — the atomic claim is —
 * so a race between this check and the claim is expected and handled there,
 * not here (see Design Decision B in the plan).
 */
const validateBarcode = async (connection, { barcode, product, equipmentType }) => {
  const item = await inventoryRepository.findByBarcode(connection, barcode);
  if (!item) {
    throw new AppError(`Barcode "${barcode}" not found in inventory`, 404, 'BARCODE_NOT_FOUND');
  }
  if (item.product_id !== product.id) {
    throw new AppError(`Barcode "${barcode}" belongs to a different product (${item.brand} ${item.model || ''})`.trim(), 409, 'BARCODE_WRONG_PRODUCT');
  }
  const allowedCategories = EQUIPMENT_TYPE_TO_CATEGORIES[equipmentType];
  if (allowedCategories && !allowedCategories.includes(item.category)) {
    throw new AppError(`Barcode "${barcode}" is a ${item.category}, not valid for the ${equipmentType} slot`, 409, 'BARCODE_WRONG_CATEGORY');
  }
  if (!item.product_is_active) {
    throw new AppError(`The product for barcode "${barcode}" is no longer active`, 409, 'BARCODE_PRODUCT_INACTIVE');
  }
  if (item.status !== 'IN_STOCK') {
    throw new AppError(`Barcode "${barcode}" is not available (current status: ${item.status})`, 409, 'BARCODE_NOT_AVAILABLE');
  }
  return item;
};

/**
 * CURRENTLY UNWIRED (temporary product decision, 2026-08-26): the warranty
 * workflow no longer performs inventory/barcode verification, so nothing
 * calls this anymore. Kept (not deleted) because the disable is explicitly
 * temporary — re-enabling means calling this again from
 * warrantyService.resolveEquipment, exactly as before.
 *
 * Manual Verification workflow — the one place that decides whether a
 * BARCODE_NOT_FOUND failure may be replaced with seller info instead of
 * blocking submission. Always calls validateBarcode first, exactly as the
 * ordinary path does — this function never trusts the caller's claim that a
 * barcode "wasn't found"; it independently re-derives the real failure
 * reason every time, which is what makes this safe:
 *
 *   - Success                              -> AUTO, unchanged behavior.
 *   - Any failure OTHER than BARCODE_NOT_FOUND (wrong product, wrong
 *     category, inactive product, not available) -> re-thrown unchanged.
 *     Manual verification must never paper over one of these — a client
 *     setting manualVerificationRequested can never turn a
 *     BARCODE_WRONG_PRODUCT/BARCODE_WRONG_CATEGORY/BARCODE_PRODUCT_INACTIVE/
 *     BARCODE_NOT_AVAILABLE into a successful submission.
 *   - BARCODE_NOT_FOUND and manualVerificationRequested is false -> re-thrown
 *     unchanged (today's existing behavior: fix the barcode or fail).
 *   - BARCODE_NOT_FOUND and manualVerificationRequested is true -> seller
 *     info is validated (business rule, not shape — same layering
 *     resolveEquipment already uses for CYLINDER_MODEL_REQUIRED) and a
 *     PENDING resolution is returned instead of an item: no inventory_item_id,
 *     nothing claimed, points withheld until an admin approves it (see
 *     warrantyService.reviewManualVerification).
 */
const validateBarcodeOrAcceptManual = async (connection, { barcode, product, equipmentType, manualVerificationRequested, sellerName, sellerPhone, comment, photoFilename, uploadedBy }) => {
  try {
    const item = await validateBarcode(connection, { barcode, product, equipmentType });
    return { verificationStatus: 'AUTO', inventoryItemId: item.id };
  } catch (error) {
    if (!(error instanceof AppError) || error.errorCode !== 'BARCODE_NOT_FOUND' || !manualVerificationRequested) {
      throw error;
    }
    if (!sellerName || !String(sellerName).trim() || !sellerPhone || !String(sellerPhone).trim() || !comment || !String(comment).trim()) {
      throw new AppError(`Seller name, seller phone, and a comment are required for manual verification of ${equipmentType}`, 400, 'SELLER_INFO_REQUIRED');
    }
    return {
      verificationStatus: 'PENDING',
      inventoryItemId: null,
      sellerName: String(sellerName).trim(),
      sellerPhone: String(sellerPhone).trim(),
      comment: String(comment).trim(),
      photoFilename: await resolveOwnedPhotoFilename(connection, photoFilename, uploadedBy),
    };
  }
};

/**
 * Manual Verification workflow — never trusts a bare client-submitted
 * filename string as a capability. A filename only gets attached if
 * manualVerificationUploadRepository shows it was actually uploaded by
 * `uploadedBy` (the same authenticated user performing THIS submission/edit)
 * — otherwise it's silently dropped (treated as "no photo"), never a hard
 * failure: a filename that doesn't check out is far more likely a stale/
 * mismatched client state than a deliberate attack, and there's nothing
 * useful about blocking the whole submission over just the photo. Called
 * both from the barcode-(re)validation paths above and directly from
 * warrantyService.updateWarrantyForm's unchanged-barcode branch, where no
 * barcode re-validation happens but the photo can still be edited.
 */
const resolveOwnedPhotoFilename = async (connection, filename, uploadedBy) => {
  if (!filename) return null;
  const upload = await manualVerificationUploadRepository.findByFilename(connection, filename);
  if (!upload || upload.uploaded_by !== uploadedBy) {
    return null;
  }
  return filename;
};

/**
 * CURRENTLY UNWIRED (temporary product decision, 2026-08-26): warranty
 * creation no longer claims inventory — no caller exists. Kept for the
 * eventual re-enable; see the note on validateBarcodeOrAcceptManual above.
 *
 * Claims one inventory item for a warranty equipment row — the actual
 * enforcement point (see Design Decision B). Must be called from inside an
 * already-open transaction; never opens its own. Throws BARCODE_CLAIM_FAILED
 * if the atomic UPDATE's WHERE clause matched nothing (lost a race, or the
 * item's state changed since validateBarcode ran) — the caller's transaction
 * then rolls back everything, not just this one claim.
 */
const claimForEquipmentRow = async (connection, { itemId, productId, changedBy, reason = 'warranty_created' }) => {
  const claimed = await inventoryRepository.claimForInstallation(connection, { itemId, productId });
  if (!claimed) {
    throw new AppError('Barcode is no longer available', 409, 'BARCODE_CLAIM_FAILED');
  }
  await inventoryRepository.insertStatusHistory(connection, {
    inventoryItemId: itemId,
    fromStatus: 'IN_STOCK',
    toStatus: 'INSTALLED',
    changedBy,
    reason,
  });
};

/**
 * CURRENTLY UNWIRED (temporary product decision, 2026-08-26): warranty
 * update/delete no longer release inventory — no caller exists. An item
 * left INSTALLED by the old flow is released via the Super-Admin manual
 * operations below, never as a warranty side effect. Kept for the eventual
 * re-enable; see the note on validateBarcodeOrAcceptManual above.
 *
 * Releases one inventory item back to IN_STOCK (warranty edited or
 * deleted). Must be called from inside an already-open transaction that has
 * already acquired warrantyRepository.lockForm's FOR UPDATE lock on the
 * warranty being edited/deleted — that lock is what makes affectedRows===0
 * here a genuine cross-warranty inconsistency worth throwing loudly for,
 * rather than a benign same-warranty race to swallow (see the Phase 2
 * plan's Critical Review #11 and Concurrency Protection section).
 */
const releaseForEquipmentRow = async (connection, { itemId, changedBy, reason }) => {
  const released = await inventoryRepository.release(connection, itemId);
  if (!released) {
    throw new AppError('Inventory item was not in an installed state — data inconsistency', 500, 'INVENTORY_RELEASE_FAILED');
  }
  await inventoryRepository.insertStatusHistory(connection, {
    inventoryItemId: itemId,
    fromStatus: 'INSTALLED',
    toStatus: 'IN_STOCK',
    changedBy,
    reason,
  });
};

/**
 * Phase 4 manual operations — Super-Admin-gated (see routes), each wrapped
 * in the caller's transaction, each requiring a `reason`. Every write is an
 * atomic, guarded UPDATE (repository layer's affectedRows check), never a
 * bare read-then-write — the same discipline claimForInstallation/release
 * already established, extended here rather than relaxed for new code.
 */

/**
 * Manually moves an item between statuses (e.g. IN_STOCK -> DAMAGED). Bound
 * to the admin's *observed* fromStatus — if the item's real status has
 * already changed (e.g. a warranty submission just claimed it), the atomic
 * UPDATE's WHERE clause matches nothing and this throws instead of silently
 * overwriting whatever the concurrent operation just did.
 */
const changeStatusManually = async (connection, { itemId, fromStatus, toStatus, reason, changedBy }) => {
  const changed = await inventoryRepository.changeStatusManually(connection, { itemId, fromStatus, toStatus });
  if (!changed) {
    throw new AppError('This item\'s status has changed since you loaded it — please refresh and try again', 409, 'ITEM_STATE_CHANGED');
  }
  await inventoryRepository.insertStatusHistory(connection, {
    inventoryItemId: itemId,
    fromStatus,
    toStatus,
    changedBy,
    reason,
  });
};

/** Moves an item to a different branch ("warehouse"). branchId may be null
 * (unassign). Logged to inventory_audit_log, not inventory_status_history —
 * this isn't a status transition. */
const transferBranch = async (connection, { itemId, newBranchId, reason, changedBy }) => {
  const item = await inventoryRepository.findById(connection, itemId);
  if (!item) {
    throw new AppError('Inventory item not found', 404, 'NOT_FOUND');
  }
  const moved = await inventoryRepository.transferBranch(connection, { itemId, branchId: newBranchId || null });
  if (!moved) {
    throw new AppError('Inventory item not found', 404, 'NOT_FOUND');
  }
  await inventoryAuditLogRepository.insert(connection, {
    inventoryItemId: itemId,
    actionType: 'BRANCH_TRANSFER',
    oldValue: item.branch_id != null ? String(item.branch_id) : null,
    newValue: newBranchId != null ? String(newBranchId) : null,
    reason,
    changedBy,
  });
};

/**
 * Corrects a barcode string (serves both "replace damaged barcode" and
 * "correct incorrect imports" — see the Phase 4 plan's Critical Review #5).
 * Restricted to non-INSTALLED items: warranty_equipment.serial_number is a
 * denormalized copy taken at claim time and never re-derived, so correcting
 * a barcode on a live, installed item would silently desync the two with no
 * automatic path to fix the copy back up (see D5). Fixing a barcode on a
 * currently-installed item is out of scope here — the existing edit-
 * warranty flow (release + reclaim) already covers that if ever needed.
 */
const correctBarcode = async (connection, { itemId, newBarcode, reason, changedBy }) => {
  if (!isValidBarcode(newBarcode)) {
    throw new AppError('Barcode must be alphanumeric (letters, numbers, hyphens only)', 400, 'VALIDATION_ERROR');
  }
  const item = await inventoryRepository.findById(connection, itemId);
  if (!item) {
    throw new AppError('Inventory item not found', 404, 'NOT_FOUND');
  }
  if (item.status === 'INSTALLED') {
    throw new AppError('Cannot correct the barcode of a currently-installed item — release it first', 409, 'ITEM_INSTALLED');
  }
  const existing = await inventoryRepository.findByBarcode(connection, newBarcode);
  if (existing) {
    throw new AppError(`Barcode "${newBarcode}" is already in use by another item`, 409, 'BARCODE_ALREADY_EXISTS');
  }
  const corrected = await inventoryRepository.correctBarcode(connection, { itemId, oldBarcode: item.barcode, newBarcode });
  if (!corrected) {
    throw new AppError('This item\'s barcode has changed since you loaded it — please refresh and try again', 409, 'ITEM_STATE_CHANGED');
  }
  await inventoryAuditLogRepository.insert(connection, {
    inventoryItemId: itemId,
    actionType: 'BARCODE_CORRECTED',
    oldValue: item.barcode,
    newValue: newBarcode,
    reason,
    changedBy,
  });
};

/**
 * Merges a duplicate inventory record into a canonical one — two distinct,
 * real barcodes that turned out to be the same physical unit (barcode is
 * globally UNIQUE, so two rows can never literally share one; see Critical
 * Review #6). History is preserved exactly as it happened, never rewritten
 * — the duplicate transitions to a terminal MERGED status pointing at the
 * canonical item, atomically guarded to only ever happen from IN_STOCK
 * (never merges an item out from under a live warranty claim).
 */
const mergeDuplicate = async (connection, { duplicateItemId, canonicalItemId, reason, changedBy }) => {
  if (duplicateItemId === canonicalItemId) {
    throw new AppError('Cannot merge an item into itself', 400, 'VALIDATION_ERROR');
  }
  const [duplicateItem, canonicalItem] = await Promise.all([
    inventoryRepository.findById(connection, duplicateItemId),
    inventoryRepository.findById(connection, canonicalItemId),
  ]);
  if (!duplicateItem || !canonicalItem) {
    throw new AppError('Inventory item not found', 404, 'NOT_FOUND');
  }
  if (duplicateItem.product_id !== canonicalItem.product_id) {
    throw new AppError('Cannot merge items belonging to different products', 400, 'MERGE_PRODUCT_MISMATCH');
  }
  const merged = await inventoryRepository.mergeDuplicate(connection, { duplicateItemId, canonicalItemId });
  if (!merged) {
    throw new AppError('This item is no longer available to merge (it may already be installed or merged)', 409, 'ITEM_STATE_CHANGED');
  }
  await inventoryAuditLogRepository.insert(connection, {
    inventoryItemId: duplicateItemId,
    actionType: 'MERGED_DUPLICATE',
    oldValue: duplicateItem.barcode,
    newValue: canonicalItem.barcode,
    reason,
    changedBy,
  });
};

module.exports = {
  importCsv,
  isValidBarcode,
  validateBarcode,
  validateBarcodeOrAcceptManual,
  resolveOwnedPhotoFilename,
  claimForEquipmentRow,
  releaseForEquipmentRow,
  changeStatusManually,
  transferBranch,
  correctBarcode,
  mergeDuplicate,
};
