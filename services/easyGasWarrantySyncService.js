/**
 * Builds the EasyGas payload for one warranty and submits it — called
 * exactly once, only after warrantyService.reviewWarrantyForm has already
 * committed that warranty's status to SUCCESSFUL (see that function; never
 * called from anywhere else). Field mapping matches the contract confirmed
 * in the standalone test-easygas.js verification, applied to a real
 * warranty row instead of a fabricated sample.
 *
 * Two fields are known-uncertain, not invented — both documented at the
 * exact line that uses them below:
 *   - branch_stag_code: no fully reliable source exists in this schema.
 *     branches.easygas_stag_code is unpopulated for every row (confirmed —
 *     see the investigation this note was updated from) and is a documented
 *     dead column slated for removal (migrations/phase2-drop-easygas-schema.js).
 *     Falls back to installer_branch_code (a snapshot of branches.code),
 *     which IS the real EasyGas-issued STAG code for the 259 branches
 *     migrated directly from stag-db/branches.sql's own `stag_code` field
 *     (confirmed 1:1 against that source file — not a coincidence for those
 *     rows) — but is a locally-invented placeholder ("STAG_001", "STAG_015",
 *     "STAG_022") for exactly 3 branches that do not appear anywhere in that
 *     source dump, at least 2 of which currently have real installers
 *     assigned. Sending one of those 3 codes to EasyGas will not match a
 *     real STAG branch. No reliable source for those 3 exists in this
 *     codebase today — not fixed here (out of scope: needs either a real
 *     easygas_stag_code from EasyGas, or their /public/api/branches endpoint,
 *     confirmed to exist but not confirmed in shape — see the investigation
 *     this note was updated from for how that was established).
 *   - components[].product_id: ambiguous whether EasyGas wants our local
 *     products.id or their own catalog id (products.external_id). Prefers
 *     external_id when known, falls back to our local id otherwise.
 *   - car_id: same resolution as product_id, added when it was discovered
 *     this field was still sending the raw local `cars.id` (an internal
 *     auto-increment PK EasyGas has never seen) instead of the synced
 *     `cars.external_id` — see resolveCarExternalId below.
 */

const warrantyRepository = require('../repositories/warrantyRepository');
const carRepository = require('../repositories/carRepository');
const { attachEquipment } = require('../utils/warrantyEquipment');
const easyGasWarrantyClient = require('./easyGasWarrantyClient');

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
    const rawBody = JSON.stringify(buildPayload(form, withEquipment.equipment, carExternalId)); // serialized exactly once

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
