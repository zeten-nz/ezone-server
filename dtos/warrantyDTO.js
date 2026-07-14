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
    easygas_sync_status: form.easygas_sync_status,
    easygas_sync_terminal: !!form.easygas_sync_terminal,
    easygas_warranty_number: form.easygas_warranty_number,
    easygas_last_error: form.easygas_last_error,
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

module.exports = { toWarrantyResponse, toWarrantyListResponse };
