/**
 * Builds the EasyGas payload for one warranty and submits it — called
 * after local creation/review commits SUCCESSFUL, or on explicit operator
 * retry. Remote failure never changes the local warranty status.
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
 *   - car_id: ONLY cars.external_id. Otherwise the catalog or conservative
 *     free text supplies brand/model. Local IDs never cross this boundary.
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

/**
 * Beta-3 NULL-CYLINDER contract (confirmed by the integration partner): a
 * warranty without a cylinder still sends the cylinder ENTRY in the
 * components array — the existing cylinder-specific fields are transmitted
 * as JSON null, never omitted and never filled with fake values (no 0, no
 * "N/A", no placeholder product ids/serials). Both documented cylinder
 * variants' fields (catalog: product_id; typed: brand_name/model; shared:
 * serial_number) are carried as null so the entry can never be mistaken for
 * a real component regardless of which variant EasyGas reads. Inserted at
 * the cylinder's canonical position (after the reducer) so component order
 * matches every previously-sent payload.
 */
const NULL_CYLINDER_COMPONENT = Object.freeze({
  component_type: 'cylinder',
  serial_number: null,
  product_id: null,
  brand_name: null,
  model: null,
});

const buildComponents = (equipment) => {
  const components = equipment.map(buildComponent);
  if (!equipment.some((row) => row.equipment_type === 'CYLINDER')) {
    const reducerIndex = components.findIndex((c) => c.component_type === 'reducer');
    components.splice(reducerIndex + 1, 0, { ...NULL_CYLINDER_COMPONENT });
  }
  return components;
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

const validExternalCarId = (value) => Number.isSafeInteger(value) && value > 0;

const resolveEasyGasVehicle = async (connection, form) => {
  let car = form.car_id != null ? await carRepository.findById(connection, form.car_id) : null;
  let source = 'selected';
  if (!car) {
    car = await carRepository.findActiveExactMatch(connection, form.vehicle_name);
    source = 'catalog_exact';
  }
  if (car) {
    const externalId = car.external_id != null ? Number(car.external_id) : null;
    return {
      carId: validExternalCarId(externalId) ? externalId : null,
      vehicleBrand: carRepository.normalizeVehicleText(car.brand) || null,
      vehicleModel: carRepository.normalizeVehicleText(car.model) || null,
      source,
    };
  }
  const name = carRepository.normalizeVehicleText(form.vehicle_name);
  const [brand, ...model] = name.split(' ');
  if (brand && model.length) {
    return { carId: null, vehicleBrand: brand, vehicleModel: model.join(' '), source: 'free_text' };
  }
  return { carId: null, vehicleBrand: null, vehicleModel: null, source: 'unresolved' };
};

const validatePayload = (payload) => {
  if (typeof payload.warranty_book_number !== 'string'
      || !payload.warranty_book_number.trim() || payload.warranty_book_number.length > 14) {
    return 'invalid_warranty_book_number: expected non-empty string of at most 14 characters';
  }
  if (!validExternalCarId(payload.car_id)
      && !(typeof payload.vehicle_brand === 'string' && payload.vehicle_brand.trim()
        && typeof payload.vehicle_model === 'string' && payload.vehicle_model.trim())) {
    return 'vehicle_identity_unresolved: no EasyGas car_id and vehicle_brand/vehicle_model could not be resolved';
  }
  return null;
};

const buildPayload = (form, equipment, resolvedVehicle) => ({
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
  // Vehicle identity was explicitly resolved before this pure mapping.
  car_id: resolvedVehicle.carId,
  vehicle_brand: resolvedVehicle.vehicleBrand,
  vehicle_model: resolvedVehicle.vehicleModel,
  vehicle_production_year: form.vehicle_production_year,
  vehicle_vin: form.vehicle_vin,
  vehicle_mileage: form.vehicle_mileage,
  vehicle_plate_number: form.vehicle_plate_number,
  owner_full_name: form.owner_full_name,
  owner_phone: form.owner_phone,
  components: buildComponents(equipment), // Beta-3: absent local cylinder → null-valued cylinder entry, never omitted
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
    // Resolve persisted local vehicle data before constructing the payload.
    const resolvedVehicle = await resolveEasyGasVehicle(connection, form);
    const payload = buildPayload(form, withEquipment.equipment, resolvedVehicle);
    const contractError = validatePayload(payload);
    if (contractError) {
      await warrantyRepository.updateEasyGasSyncResult(connection, formId, {
        result: 'FAILED', claimUrl: null, error: contractError,
      });
      return;
    }

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
    payload.owner_phone = ownerPhone;
    payload.organization_phone = organizationPhone;
    const rawBody = JSON.stringify(payload); // serialized exactly once

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

module.exports = { syncWarrantyForm, buildPayload, resolveEasyGasVehicle, validatePayload };
