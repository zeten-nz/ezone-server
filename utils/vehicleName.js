/**
 * vehicle_name is the new single field ("Chevrolet Cobalt"); historical rows
 * predating this redesign only have separate vehicle_brand/vehicle_model.
 * Shared by warrantyDTO (API responses) and excelController (exports) so
 * this fallback lives in exactly one place.
 */
const resolveVehicleName = (form) => form.vehicle_name || `${form.vehicle_brand || ''} ${form.vehicle_model || ''}`.trim() || null;

module.exports = { resolveVehicleName };
