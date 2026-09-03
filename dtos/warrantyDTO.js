/**
 * Maps a raw warranty_forms row (+ attached `equipment`, see
 * utils/warrantyEquipment.js) to the public API shape. This is the one
 * place DB column names (including the pre-existing `employee_id` FK,
 * which stays physical in SQL — see the plan's reasoning on why it's not
 * renamed at the schema level) are translated into the installer-terminology
 * contract the frontend actually consumes. Applied to every read path
 * (list/detail/search/mine) so no endpoint is left leaking raw columns.
 */

const { resolveVehicleName } = require('../utils/vehicleName');

const LEGACY_FIELDS = [
  'reducer_fuel_type', 'reducer_manufacturer', 'reducer_serial_number',
  'cylinder_fuel_type', 'cylinder_manufacturer', 'cylinder_serial_number',
  'stag_controller_manufacturer', 'stag_controller_serial_number',
  'injector_rail_manufacturer', 'injector_rail_serial_number',
];

const extractLegacyEquipment = (form) => {
  const out = {};
  let any = false;
  for (const field of LEGACY_FIELDS) {
    if (form[field] != null) {
      out[field] = form[field];
      any = true;
    }
  }
  return any ? out : null;
};

const toWarrantyResponse = (form) => {
  const equipment = form.equipment || [];
  return {
    id: form.id,
    installer: {
      id: form.employee_id,
      full_name: form.installer_full_name,
      phone: form.installer_phone,
      region: form.installer_region,
      district: form.installer_district,
      branch: form.installer_branch,
      branch_code: form.installer_branch_code,
    },
    employee_name: form.employee_name,
    employee_username: form.employee_username,
    warranty_book_number: form.warranty_book_number,
    submission_uuid: form.submission_uuid,
    // Warranty status workflow — the form's own lifecycle. Deliberately
    // separate from equipment[].verification_status (Manual Verification,
    // a per-equipment-row barcode concern) — never conflate the two.
    status: form.status,
    reviewed_by: form.reviewed_by,
    reviewed_at: form.reviewed_at,
    review_notes: form.review_notes,
    // EasyGas sync result — populated only once `status` above is
    // SUCCESSFUL and a sync attempt has actually run (see
    // easyGasWarrantySyncService.js). easygas_claim_url is what the
    // frontend's "View EasyGas Warranty" button opens.
    easygas_claim_url: form.easygas_claim_url,
    easygas_sync_result: form.easygas_sync_result,
    easygas_sync_completed_at: form.easygas_sync_completed_at,
    easygas_sync_error: form.easygas_sync_error,
    installation_date: form.installation_date,
    fuel_type: form.fuel_type,
    vehicle_name: resolveVehicleName(form),
    car_id: form.car_id,
    vehicle_production_year: form.vehicle_production_year,
    vehicle_plate_number: form.vehicle_plate_number,
    vehicle_vin: form.vehicle_vin,
    vehicle_mileage: form.vehicle_mileage,
    owner_full_name: form.owner_full_name,
    owner_phone: form.owner_phone,
    equipment,
    legacy_equipment: equipment.length === 0 ? extractLegacyEquipment(form) : null,
    created_at: form.created_at,
    updated_at: form.updated_at,
  };
};

const toWarrantyListResponse = (forms) => forms.map(toWarrantyResponse);

/**
 * SAFE customer-lookup shape (Beta-1) — an explicit ALLOWLIST for the
 * authenticated technician "find customer by phone" endpoint. Deliberately
 * NOT toWarrantyResponse: that full shape carries admin/internal fields a
 * service technician has no business seeing (easygas_sync_error,
 * review_notes, reviewed_by, per-row Manual Verification seller data,
 * inventory_item_id, submission_uuid, ...). Only service-relevant fields are
 * mapped here — never spread `form`/`row`, always name each field, so a new
 * DB column can never leak into this response by default.
 *
 * easygas_claim_url IS included: the employee's own Warranty History already
 * legitimately exposes it (QR), and the returning customer is exactly who
 * the claim QR is for.
 */
const toWarrantyLookupItem = (form) => ({
  id: form.id,
  warranty_book_number: form.warranty_book_number,
  status: form.status,
  created_at: form.created_at,
  installation_date: form.installation_date,
  owner_full_name: form.owner_full_name,
  owner_phone: form.owner_phone,
  vehicle_name: resolveVehicleName(form),
  vehicle_plate_number: form.vehicle_plate_number,
  vehicle_vin: form.vehicle_vin,
  vehicle_production_year: form.vehicle_production_year,
  vehicle_mileage: form.vehicle_mileage,
  fuel_type: form.fuel_type,
  installer: {
    full_name: form.installer_full_name,
    phone: form.installer_phone,
    branch: form.installer_branch,
    branch_code: form.installer_branch_code,
  },
  easygas_claim_url: form.easygas_claim_url,
  equipment: (form.equipment || []).map((row) => ({
    equipment_type: row.equipment_type,
    product_name: row.product_name,
    serial_number: row.serial_number,
    // typed-cylinder historical fields — free-text brand+capacity rows
    brand_name: row.brand_name,
    model: row.model,
  })),
  // Historical pre-equipment-redesign rows only have the flat legacy fields
  // — same fallback the detail modal uses, restricted to product+serial.
  legacy_equipment: (form.equipment || []).length === 0 ? extractLegacyEquipment(form) : null,
});

const toWarrantyLookupResponse = (forms) => forms.map(toWarrantyLookupItem);

module.exports = { toWarrantyResponse, toWarrantyListResponse, toWarrantyLookupResponse };
