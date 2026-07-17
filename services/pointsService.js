const AppError = require('../utils/AppError');
const pointTransactionRepository = require('../repositories/pointTransactionRepository');
const productPointConfigRepository = require('../repositories/productPointConfigRepository');

const MANUAL_TYPES = ['MANUAL_ADJUSTMENT', 'MANUAL_BONUS', 'MANUAL_PENALTY'];

/**
 * Awards points for one warranty equipment row, called from inside
 * warrantyService's already-open transaction (create, or the reaward half of
 * an update's changed-row branch). Reads the product's *currently configured*
 * point value — never a value resolved earlier in the request — so a config
 * change can't apply retroactively to an award that logically started
 * before it. Writes nothing if the product isn't configured for points (0),
 * per the Phase 3 plan's Design Decision 3 — every ledger row should mean
 * something happened, not record a no-op.
 */
const awardForEquipmentRow = async (connection, { installerId, warrantyFormId, warrantyEquipmentId, productId, equipmentType, productLabel, createdBy }) => {
  const points = await productPointConfigRepository.getPoints(connection, productId);
  if (points === 0) return null;

  const reason = `Warranty #${warrantyFormId} — ${equipmentType}${productLabel ? ` — ${productLabel}` : ''}`;
  return pointTransactionRepository.insert(connection, {
    installerId,
    points,
    transactionType: 'WARRANTY_AWARD',
    warrantyFormId,
    warrantyEquipmentId,
    productId,
    reason,
    createdBy,
  });
};

/**
 * Reverses whatever is currently outstanding for one warranty equipment row
 * — always computed from the live ledger (SUM), never a stored balance, so
 * it's correct regardless of how many prior award/reversal pairs exist.
 * Deliberately does NOT take an installerId: it derives one from the ledger
 * itself, because deleteWarrantyForm has no installer identity in scope (the
 * acting user may not be the warranty's owner — admins delete others'
 * warranties) and every award for a given warranty_equipment_id was always
 * credited to that warranty's one owner, so this is safe. No-ops (writes
 * nothing) if nothing is currently outstanding — covers historical rows that
 * never earned points, and repeated calls on an already-reversed row.
 *
 * warrantyFormId is passed through explicitly (not re-derived) so the
 * reversal row stays queryable by warranty_form_id just like its award —
 * callers always have it in scope already. product_id is carried over from
 * the most recent award for this row (the one actually being undone) so
 * "which product" stays answerable on the reversal row too, not just the award.
 */
const reverseForEquipmentRow = async (connection, { warrantyFormId, warrantyEquipmentId, reason, createdBy }) => {
  const net = await pointTransactionRepository.netForEquipmentRow(connection, warrantyEquipmentId);
  if (!net || Number(net.net) === 0) return null;

  const mostRecentAward = await pointTransactionRepository.mostRecentAwardForEquipmentRow(connection, warrantyEquipmentId);
  return pointTransactionRepository.insert(connection, {
    installerId: net.installer_id,
    points: -Number(net.net),
    transactionType: 'WARRANTY_REVERSAL',
    warrantyFormId,
    warrantyEquipmentId,
    productId: mostRecentAward?.product_id,
    reversedTransactionId: mostRecentAward?.id,
    reason,
    createdBy,
  });
};

/**
 * Manual bonus/penalty/adjustment — the only ledger writes triggered
 * directly by an admin action rather than as a warranty side effect, so they
 * need their own idempotency guard (warranty-driven rows are already covered
 * by submission_uuid's guard on the whole warranty transaction). A duplicate
 * idempotencyKey returns the ORIGINAL transaction with success rather than
 * erroring — standard idempotency-key semantics, so a retried/double-clicked
 * submission looks like confirmed success, not an ambiguous failure.
 */
const createManualTransaction = async (connection, { installerId, points, transactionType, reason, createdBy, idempotencyKey }) => {
  if (!MANUAL_TYPES.includes(transactionType)) {
    throw new AppError('Invalid manual transaction type', 400, 'VALIDATION_ERROR');
  }
  if (!reason || !reason.trim()) {
    throw new AppError('A reason is required for manual point transactions', 400, 'REASON_REQUIRED');
  }
  if (!Number.isInteger(points) || points === 0) {
    throw new AppError('Points must be a non-zero integer', 400, 'VALIDATION_ERROR');
  }
  if (transactionType === 'MANUAL_BONUS' && points <= 0) {
    throw new AppError('A bonus must be a positive amount', 400, 'VALIDATION_ERROR');
  }
  if (transactionType === 'MANUAL_PENALTY' && points >= 0) {
    throw new AppError('A penalty must be a negative amount', 400, 'VALIDATION_ERROR');
  }

  if (idempotencyKey) {
    const existing = await pointTransactionRepository.findByIdempotencyKey(connection, idempotencyKey);
    if (existing) return existing;
  }

  const id = await pointTransactionRepository.insert(connection, {
    installerId,
    points,
    transactionType,
    reason: reason.trim(),
    idempotencyKey,
    createdBy,
  });
  return { id, installer_id: installerId, points, transaction_type: transactionType, reason: reason.trim(), created_by: createdBy };
};

const getInstallerLedger = async (connection, installerId, { page, limit }) => {
  const [{ rows, total }, installerTotal] = await Promise.all([
    pointTransactionRepository.findByInstaller(connection, installerId, { page, limit }),
    pointTransactionRepository.getInstallerTotal(connection, installerId),
  ]);
  return { rows, total, installerTotal };
};

const listProductConfigs = (connection, { page, limit, search }) =>
  productPointConfigRepository.listWithProducts(connection, { page, limit, search });

const setProductConfig = async (connection, { productId, points, updatedBy }) => {
  if (!Number.isInteger(points) || points < 0) {
    throw new AppError('Points must be a non-negative integer', 400, 'VALIDATION_ERROR');
  }
  await productPointConfigRepository.upsert(connection, { productId, points, updatedBy });
};

module.exports = {
  awardForEquipmentRow,
  reverseForEquipmentRow,
  createManualTransaction,
  getInstallerLedger,
  listProductConfigs,
  setProductConfig,
};
