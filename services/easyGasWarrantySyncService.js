/**
 * Builds the EasyGas payload for one warranty and submits it — called
 * exactly once, only after warrantyService.reviewWarrantyForm has already
 * committed that warranty's status to SUCCESSFUL (see that function; never
 * called from anywhere else). Field mapping matches the contract confirmed
 * in the standalone test-easygas.js verification, applied to a real
 * warranty row instead of a fabricated sample.
 *
 * Field-source decisions, documented at the exact line that uses each below:
 *   - branch_stag_code: LOCAL branches are authoritative (FINAL architecture
 *     decision — no EasyGas branch sync exists or will be added, and
 *     branches.easygas_stag_code is a dead column slated for removal, never
 *     read). The value sent is warranty_forms.installer_branch_code — a
 *     snapshot of the installer's branch's own branches.code, copied by
 *     getEmployeeSnapshot at warranty CREATION time and immutable afterward
 *     (deliberately: re-resolving via the employee's CURRENT branch at
 *     approval time would mis-attribute the warranty if the employee changed
 *     branches between creation and approval). A real POST has confirmed
 *     EasyGas accepts these codes verbatim (e.g. "01/1"). Known data caveat,
 *     deliberately NOT worked around in code: 3 legacy branches (STAG_001/
 *     STAG_015/STAG_022) carry locally-invented codes EasyGas never issued —
 *     a submission from one of them will be rejected by EasyGas and that
 *     failure is recorded and surfaced normally, never hidden or faked.
 *   - components[].product_id: EasyGas's own catalog id — prefers the synced
 *     products.external_id, local-id fallback only when external_id is
 *     absent (documented fallback, not the norm).
 *   - car_id: same resolution as product_id, added when it was discovered
 *     this field was still sending the raw local `cars.id` (an internal
 *     auto-increment PK EasyGas has never seen) instead of the synced
 *     `cars.external_id`.
 *   - owner_phone / organization_phone: canonicalized formatting-only
 *     (toEasyGasPhone) then validated against EasyGas's +998XXXXXXXXX shape
 *     immediately before the POST (see the guard in syncWarrantyForm) —
 *     every real branches.phone is stored with human spacing, and
 *     historical owner_phone rows predating creation-time validation hold
 *     other shapes (see utils/phoneFormat.js); a value that can't be
 *     canonicalized without guessing fails the sync cleanly rather than
 *     reach EasyGas. Stored data is never rewritten.
 */

const warrantyRepository = require('../repositories/warrantyRepository');
const carRepository = require('../repositories/carRepository');
const { attachEquipment } = require('../utils/warrantyEquipment');
const easyGasWarrantyClient = require('./easyGasWarrantyClient');
const { PHONE_REGEX } = require('../config/validation');

const COMPONENT_TYPE_MAP = {
  REDUCER: 'reducer',
  CONTROLLER: 'controller',
  INJECTOR_RAIL: 'injector',
  CYLINDER: 'cylinder',
};

const buildComponent = (row) => {
  const base = {
    component_type: COMPONENT_TYPE_MAP[row.equipment_type],
    serial_number: row.serial_number || null,
  };
  // Typed cylinder — no catalog product at all, matches the spec's
  // documented alternative shape exactly (see warrantyService.resolveEquipment's
  // isTypedCylinder branch, the same condition this mirrors).
  if (row.equipment_type === 'CYLINDER' && !row.product_id) {
    return { ...base, brand_name: row.brand_name, model: row.model };
  }
  const productId = row.product_external_id != null ? Number(row.product_external_id) : row.product_id;
  return { ...base, product_id: productId };
};

const toDateOnly = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date) ? null : date.toISOString().slice(0, 10);
};

/**
 * Formatting-only canonicalization of a phone number for the EasyGas
 * payload — returns the '+998XXXXXXXXX' form, or null if the value can't
 * reach that shape without guessing. Stored data is NEVER rewritten; this
 * runs only on the outbound copy.
 *
 * Why normalization exists at all: EVERY active branch's branches.phone is
 * stored with human formatting ('+998 XX XXX XX XX' — confirmed 259/259
 * populated rows), and EasyGas verifiably accepted that spaced shape in the
 * real 201-Created contract test. Validating the raw stored value against
 * the strict regex would therefore fail 100% of syncs for a
 * formatting-only difference. So: strip formatting characters (spaces,
 * dashes, parentheses — nothing else), accept '+998…' as-is, and add only
 * the '+' sign when the full '998…' country-coded number is already there.
 * A bare 9-digit national number is deliberately REJECTED, not auto-prefixed
 * — prepending a country code to a number that never carried one is exactly
 * the "blind +998 prepend" this codebase's history warns against (see
 * utils/phoneFormat.js — that utility reduces to 9 digits for COMPARISON
 * and is intentionally not reused here, since sending a 9-digit reduction
 * would discard the '+998' EasyGas requires).
 */
const toEasyGasPhone = (value) => {
  const stripped = String(value || '').replace(/[\s\-()]/g, '');
  if (/^\+998\d{9}$/.test(stripped)) return stripped;
  if (/^998\d{9}$/.test(stripped)) return `+${stripped}`;
  return null;
};

const buildPayload = (form, equipment, carExternalId) => ({
  submission_uuid: form.submission_uuid,
  warranty_book_number: form.warranty_book_number,
  branch_stag_code: form.installer_branch_code,
  fuel_type: (form.fuel_type || '').toLowerCase(),
  installer_full_name: form.installer_full_name,
  organization_name: form.installer_branch,
  organization_phone: form.organization_phone,
  installation_date: toDateOnly(form.installation_date),
  region: form.installer_region,
  city: form.city,
  district: form.installer_district,
  // Prefers the synced EasyGas catalog id (cars.external_id) — same
  // resolution as components[].product_id below, and for the same reason:
  // form.car_id alone is our own local auto-increment PK, never something
  // EasyGas issued. Falls back to the local id only when the car has no
  // external_id yet (or form.car_id is null — the free-text vehicle_brand/
  // vehicle_model fields above are always the valid fallback in that case,
  // exactly as before this fix).
  car_id: carExternalId != null ? carExternalId : form.car_id,
  vehicle_brand: form.vehicle_brand,
  vehicle_model: form.vehicle_model,
  vehicle_production_year: form.vehicle_production_year,
  vehicle_vin: form.vehicle_vin,
  vehicle_mileage: form.vehicle_mileage,
  vehicle_plate_number: form.vehicle_plate_number,
  owner_full_name: form.owner_full_name,
  owner_phone: form.owner_phone,
  components: equipment.map(buildComponent),
  external_ref: String(form.id),
});

/**
 * Never throws — a sync failure (network error, non-2xx, malformed
 * response) is recorded on the row via updateEasyGasSyncResult and nothing
 * more. The warranty's own `status` (already committed SUCCESSFUL before
 * this runs) is never touched here, in either direction: EasyGas
 * reachability is not a condition of the admin's approval decision.
 *
 * Takes `pool`, not a `connection` — deliberately acquires and releases its
 * own connection rather than reusing the review transaction's, same
 * narrow, deliberate exception easyGasCatalogSyncService.js already
 * documents for EasyGas sync code. The review transaction has already
 * committed and released its own connection back to the pool by the time
 * this runs (see warrantyService.reviewWarrantyForm); holding a pooled
 * connection open for the full duration of an external HTTP call (up to
 * 15s) would needlessly starve the pool (DB_POOL_SIZE defaults to 10)
 * under concurrent approvals.
 */
const syncWarrantyForm = async (pool, formId) => {
  const connection = await pool.getConnection();
  try {
    const form = await warrantyRepository.findDetailById(connection, formId);
    const [withEquipment] = await attachEquipment(connection, [form]);
    // See buildPayload's car_id comment — resolves the synced EasyGas
    // catalog id before payload construction so buildPayload itself can
    // stay a pure function. Reuses the existing carRepository.findById
    // (unmodified) rather than adding a JOIN to findDetailById's shared
    // query, which many unrelated warranty read paths also depend on.
    const car = form.car_id ? await carRepository.findById(connection, form.car_id) : null;
    const carExternalId = car?.external_id != null ? Number(car.external_id) : null;

    // Pre-POST phone guard — the payload's phones must be +998XXXXXXXXX
    // exactly (same PHONE_REGEX authRoutes already enforces for
    // registration). Each is canonicalized formatting-only first (see
    // toEasyGasPhone — stored branch/warranty data is never rewritten) and
    // validated after: new warranties' owner_phone is already strict at
    // creation (warrantyRoutes), but rows created before that rule — and
    // organization_phone, a snapshot of branches.phone that is stored with
    // human spacing in every real row — can hold other shapes. Anything
    // that can't be canonicalized without guessing fails the sync cleanly
    // here, never reaching EasyGas: recorded as FAILED with a
    // machine-readable `invalid_phone:` prefix (surfaced to the admin via
    // easygas_sync_error, same as every other sync failure), no POST sent.
    const ownerPhone = toEasyGasPhone(form.owner_phone);
    const organizationPhone = toEasyGasPhone(form.organization_phone);
    const invalidPhones = [];
    if (!ownerPhone || !PHONE_REGEX.test(ownerPhone)) invalidPhones.push('owner_phone');
    if (!organizationPhone || !PHONE_REGEX.test(organizationPhone)) invalidPhones.push('organization_phone');
    if (invalidPhones.length > 0) {
      await warrantyRepository.updateEasyGasSyncResult(connection, formId, {
        result: 'FAILED',
        claimUrl: null,
        error: `invalid_phone:${invalidPhones.join(',')} — expected +998XXXXXXXXX, request not sent to EasyGas`,
      });
      return;
    }

    // The payload carries the canonicalized values (the exact strings just
    // validated) — the stored row itself is untouched.
    const normalizedForm = { ...form, owner_phone: ownerPhone, organization_phone: organizationPhone };
    const rawBody = JSON.stringify(buildPayload(normalizedForm, withEquipment.equipment, carExternalId)); // serialized exactly once

    const result = await easyGasWarrantyClient.submitWarranty(rawBody);

    if (result.ok && result.data?.warranty?.claim_url) {
      await warrantyRepository.updateEasyGasSyncResult(connection, formId, {
        result: 'SUCCESS',
        claimUrl: result.data.warranty.claim_url,
        error: null,
      });
    } else {
      const errorMessage = result.networkError
        ? `Network error: ${result.errorMessage}`
        : `HTTP ${result.status}: ${JSON.stringify(result.data)}`;
      await warrantyRepository.updateEasyGasSyncResult(connection, formId, {
        result: 'FAILED',
        claimUrl: null,
        error: errorMessage.slice(0, 500),
      });
    }
  } finally {
    connection.release();
  }
};

module.exports = { syncWarrantyForm, buildPayload };
