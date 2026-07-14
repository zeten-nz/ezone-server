const easyGasWarrantyClient = require('./easyGasWarrantyClient');
const equipmentRepository = require('../repositories/equipmentRepository');

const EQUIPMENT_TYPE_FIELD_PREFIX = {
  REDUCER: 'reducer',
  CYLINDER: 'cylinder',
  CONTROLLER: 'controller',
  INJECTOR_RAIL: 'injector_rail',
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
]);

/**
 * Field names below are inferred from EasyGas's error-code documentation
 * (which references `<type>_product_id`, `submission_uuid`, region/city/
 * district, VIN, vehicle_production_year, vehicle_mileage,
 * installation_date, branch_stag_code) — they have not shared a literal
 * field-by-field request schema yet. Treat this as a best-effort starting
 * point; confirm against their real API docs/Postman collection before
 * relying on it for production traffic.
 */
const buildPayload = (warranty, equipmentRows) => {
  const payload = {
    submission_uuid: warranty.submission_uuid,
    branch_stag_code: warranty.installer_branch_code,
    installer_full_name: warranty.installer_full_name,
    installer_phone: warranty.installer_phone,
    region: warranty.installer_region,
    district: warranty.installer_district,
    city: warranty.city,
    installation_date: warranty.installation_date,
    fuel_type: warranty.fuel_type,
    vehicle_vin: warranty.vehicle_vin,
    vehicle_production_year: warranty.vehicle_production_year,
    vehicle_mileage: warranty.vehicle_mileage,
    vehicle_plate_number: warranty.vehicle_plate_number,
    owner_full_name: warranty.owner_full_name,
    owner_phone: warranty.owner_phone,
  };

  for (const row of equipmentRows) {
    const prefix = EQUIPMENT_TYPE_FIELD_PREFIX[row.equipment_type];
    payload[`${prefix}_product_id`] = row.product_external_id;
    payload[`${prefix}_serial_number`] = row.serial_number;
  }

  return payload;
};

/** `resolveEquipment` (warrantyService.js) deliberately never checks for a
 * missing products.external_id — that would couple local warranty creation
 * to catalog-sync completeness. This is where that check actually belongs:
 * a warranty can be saved locally today even if one of its products hasn't
 * been matched to EasyGas's catalog yet, but it can't be PUSHED until it has. */
const findUnmappedEquipmentType = (equipmentRows) =>
  equipmentRows.find((row) => !row.product_external_id)?.equipment_type || null;

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
    return { outcome: 'success', warrantyNumber: result.data?.warranty_number || null };
  }
  if (result.status >= 500) {
    return { outcome: 'retry', message: `SERVER_ERROR: EasyGas returned HTTP ${result.status}` };
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
  const [warrantyRows] = await pool.execute('SELECT * FROM warranty_forms WHERE id = ?', [warrantyId]);
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
