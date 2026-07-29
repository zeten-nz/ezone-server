const easyGasWarrantyClient = require('./easyGasWarrantyClient');
const equipmentRepository = require('../repositories/equipmentRepository');
const { normalizeToEasyGasPhone } = require('../utils/phoneFormat');

const EQUIPMENT_TYPE_COMPONENT_TYPE = {
  REDUCER: 'reducer',
  CYLINDER: 'cylinder',
  CONTROLLER: 'controller',
  INJECTOR_RAIL: 'injector', // EasyGas confirmed this value; was 'injector_rail'
};

// 409s EasyGas documents as "safe to retry" — not "already applied," so
// these go through the retry path (their own idempotency-by-submission_uuid
// guarantee means a clean retry returns the correct, already-stored result
// including the warranty number, rather than us guessing success without one).
const RETRYABLE_ERROR_CODES = new Set(['DUPLICATE_SUBMISSION', 'CONFLICT']);

// A human has to fix something (our data, or wait for EasyGas's own genuine-
// serials list to load) before retrying could ever succeed — never
// auto-retried by the sweep. SERIAL_UNKNOWN/SERIAL_PRODUCT_MISMATCH aren't
// live yet per EasyGas's own note, but are handled identically from day one
// so nothing on our side needs to change when they switch on.
const TERMINAL_ERROR_CODES = new Set([
  'PRODUCT_UNKNOWN', 'FIELD_TOO_LONG', 'INVALID_VALUE', 'INVALID_DATE',
  'WARRANTY_LOCKED', 'SERIAL_ALREADY_USED', 'SERIAL_UNKNOWN', 'SERIAL_PRODUCT_MISMATCH',
  'FIELD_REQUIRED', 'BRANCH_UNKNOWN', 'CAR_UNKNOWN', 'FUEL_TYPE_MISMATCH',
  'COMPONENTS_INCOMPLETE', 'PHONE_INVALID',
]);

/**
 * Field shape confirmed via a controlled, isolated A/B test against
 * EasyGas's live API — two otherwise-identical signed requests, one flat,
 * one nested. Flat produced `components: COMPONENTS_INCOMPLETE` (the API
 * checking for a field named `components` we hadn't sent); nested made
 * that error disappear entirely and reach real per-product validation
 * (`PRODUCT_UNKNOWN` on each fake id) — proof the nested array is what's
 * actually read as input. The flat `<type>_product_id` field names seen in
 * BOTH tests' error responses are the API's error-display convention only
 * (so each error maps cleanly onto a flat form input), decoupled from the
 * actual request shape — a genuinely confusing wrinkle, not a flat input
 * contract. `installer_phone` is deliberately not sent: it doesn't appear
 * in EasyGas's confirmed field list, only `installer_full_name` does.
 * `vehicle_brand`/`vehicle_model` are also not sent — see the known gap
 * noted in the approved plan: this codebase has no split brand/model
 * capture for the case where no `car_id` is chosen (only a combined
 * free-text `vehicle_name`), so submissions without a catalog car will get
 * `FIELD_REQUIRED` (car_id null) from EasyGas until that's addressed on
 * the input side.
 */
const buildPayload = (warranty, equipmentRows) => {
  const payload = {
    submission_uuid: warranty.submission_uuid,
    external_ref: warranty.id,
    branch_stag_code: warranty.easygas_stag_code,
    fuel_type: (warranty.fuel_type || '').toLowerCase(),
    installer_full_name: warranty.installer_full_name,
    organization_name: warranty.installer_branch,
    organization_phone: warranty.organization_phone,
    installation_date: warranty.installation_date,
    region: warranty.installer_region,
    city: warranty.city,
    district: warranty.installer_district,
    car_id: warranty.car_id || null,
    vehicle_production_year: warranty.vehicle_production_year,
    vehicle_plate_number: warranty.vehicle_plate_number,
    vehicle_vin: warranty.vehicle_vin,
    vehicle_mileage: warranty.vehicle_mileage,
    owner_full_name: warranty.owner_full_name,
    owner_phone: normalizeToEasyGasPhone(warranty.owner_phone),
    // A CYLINDER row with no product_id is a typed cylinder (EasyGas's
    // catalog only carries 2 CNG models — not enough for what installers
    // actually fit) — sent as free-text brand_name/model instead of a
    // catalog product_id. The other 3 types are always catalog-driven.
    components: equipmentRows.map((row) => {
      const isTypedCylinder = row.equipment_type === 'CYLINDER' && !row.product_id;
      if (isTypedCylinder) {
        return {
          component_type: 'cylinder',
          brand_name: row.brand_name || undefined,
          model: row.model,
          serial_number: row.serial_number || undefined,
        };
      }
      return {
        component_type: EQUIPMENT_TYPE_COMPONENT_TYPE[row.equipment_type],
        product_id: row.product_external_id,
        serial_number: row.serial_number,
      };
    }),
  };

  return payload;
};

/** `resolveEquipment` (warrantyService.js) deliberately never checks for a
 * missing products.external_id — that would couple local warranty creation
 * to catalog-sync completeness. This is where that check actually belongs:
 * a warranty can be saved locally today even if one of its products hasn't
 * been matched to EasyGas's catalog yet, but it can't be PUSHED until it has.
 * A typed cylinder (no product_id at all, by design) is never "unmapped" —
 * it was never supposed to have a catalog match. */
const findUnmappedEquipmentType = (equipmentRows) =>
  equipmentRows.find((row) => {
    const isTypedCylinder = row.equipment_type === 'CYLINDER' && !row.product_id;
    return !isTypedCylinder && !row.product_external_id;
  })?.equipment_type || null;

// Every returned `message` below consistently leads with `CODE: detail` (a
// bare, colon-terminated token first) — the admin UI's Sync Status badge
// (see AdminWarrantyFormsModern.jsx) parses that leading token and looks it
// up in errorCodes.js for a translated, human-readable reason. Keep this
// format whenever adding a new branch here; a message that doesn't lead
// with a recognizable code just falls back to a generic translation
// frontend-side, but the leading token should still exist.
const classifyResult = (result) => {
  if (result.networkError) {
    return { outcome: 'retry', message: `NETWORK_ERROR: ${result.errorMessage}` };
  }
  if (result.ok) {
    return { outcome: 'success', warrantyNumber: result.data?.warranty?.warranty_book_number || null };
  }
  if (result.status >= 500) {
    return { outcome: 'retry', message: `SERVER_ERROR: EasyGas returned HTTP ${result.status}` };
  }
  // Explicit, not inferred from the unclassified fallback below: a 401/403
  // is a global config problem (bad/rotated EASYGAS_SHARED_SECRET, clock
  // skew), never a per-warranty data problem — every row would fail
  // identically. Retry (not terminal) so the fix is zero-touch: the moment
  // ops corrects the secret, the very next sweep cycle just starts
  // succeeding, instead of requiring every affected row to be manually
  // reset via retry-sync. easygas_last_error still surfaces this to admins.
  if (result.status === 401 || result.status === 403) {
    return { outcome: 'retry', message: `AUTH_FAILED: EasyGas returned HTTP ${result.status} — check EASYGAS_SHARED_SECRET` };
  }

  const errors = Array.isArray(result.data?.errors) ? result.data.errors : [];
  const codes = errors.map((e) => e.code);
  const detail = errors.map((e) => `${e.field ? `${e.field}: ` : ''}${e.message || e.code}`).join('; ') || `HTTP ${result.status}`;

  const retryableCode = codes.find((code) => RETRYABLE_ERROR_CODES.has(code));
  if (retryableCode) {
    return { outcome: 'retry', message: `${retryableCode}: ${detail}` };
  }
  const terminalCode = codes.find((code) => TERMINAL_ERROR_CODES.has(code));
  if (terminalCode) {
    return { outcome: 'terminal', message: `${terminalCode}: ${detail}` };
  }
  // Unrecognized shape — conservatively retry rather than guess terminal and
  // strand a warranty an admin can't otherwise see anything wrong with.
  return { outcome: 'retry', message: `UNCLASSIFIED_ERROR: (HTTP ${result.status}) ${detail}` };
};

/**
 * Pushes one warranty to EasyGas. Takes `pool` (not a shared `connection`) —
 * every DB read/write here is its own short-lived `pool.execute()` call, so
 * no connection is ever held across the `easyGasWarrantyClient` HTTP call in
 * between. Returns a classification the sweep applies as the row's next
 * status; never throws (matches easyGasWarrantyClient's own never-rejects contract).
 */
const syncWarranty = async (pool, warrantyId) => {
  // LEFT JOIN on branches.code (confirmed immutable once created — see
  // branchController.js) rather than a live join through the employee's
  // current branch: warranty_forms.installer_branch_code is a frozen
  // snapshot taken at submission time, so this must resolve the branch as
  // of submission, not wherever the installer is assigned today. Unmatched/
  // NULL installer_branch_code (the common case today) simply yields
  // easygas_stag_code: null.
  const [warrantyRows] = await pool.execute(
    `SELECT wf.*, b.easygas_stag_code
     FROM warranty_forms wf
     LEFT JOIN branches b ON b.code = wf.installer_branch_code
     WHERE wf.id = ?`,
    [warrantyId]
  );
  const warranty = warrantyRows[0];
  if (!warranty) {
    return { outcome: 'terminal', message: 'Warranty no longer exists' };
  }

  const equipmentRows = await equipmentRepository.findByWarrantyFormIds(pool, [warrantyId]);
  const unmappedType = findUnmappedEquipmentType(equipmentRows);
  if (unmappedType) {
    return { outcome: 'terminal', message: `PRODUCT_NOT_MAPPED: ${unmappedType} has no EasyGas catalog match yet` };
  }

  const payload = buildPayload(warranty, equipmentRows);
  const result = await easyGasWarrantyClient.submitWarranty(payload);
  return classifyResult(result);
};

module.exports = { buildPayload, classifyResult, findUnmappedEquipmentType, syncWarranty };
