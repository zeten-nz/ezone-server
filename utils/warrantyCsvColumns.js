/**
 * Warranty CSV export column definitions (extracted from exportCsvController so the column set + per-equipment
 * resolution are unit-testable without a DB). The full column set mirrors the admin "View Warranty" detail view
 * (§9): general, installer/branch, owner, vehicle, per-equipment product+serial (SEPARATE machine-readable columns,
 * never one giant cell), EasyGas result + claim URL, and admin review. Every value is escaped centrally by
 * utils/csvStream.js (formula-injection + RFC-4180), so nothing here needs to escape.
 */
const { translateEnum, formatCsvDate } = require('../config/csvLabels');
const { resolveVehicleName } = require('./vehicleName');

const EQUIPMENT_TYPES = ['REDUCER', 'CYLINDER', 'CONTROLLER', 'INJECTOR_RAIL'];

// Legacy flat free-text columns on warranty_forms — used only when a historical warranty has no normalized
// warranty_equipment row for that slot (§11), so old exports stay useful.
const LEGACY_EQUIPMENT_FIELDS = {
  REDUCER: { product: 'reducer_manufacturer', serial: 'reducer_serial_number' },
  CYLINDER: { product: 'cylinder_manufacturer', serial: 'cylinder_serial_number' },
  CONTROLLER: { product: 'stag_controller_manufacturer', serial: 'stag_controller_serial_number' },
  INJECTOR_RAIL: { product: 'injector_rail_manufacturer', serial: 'injector_rail_serial_number' },
};

const equipmentRowFor = (form, type) => (form.equipment || []).find((e) => e.equipment_type === type) || null;

/** Product label for a slot: normalized row first (product_name, or brand+model for a typed cylinder), else legacy flat field. */
const equipmentProduct = (form, type) => {
  const row = equipmentRowFor(form, type);
  if (row) return row.product_name || [row.brand_name, row.model].filter(Boolean).join(' ') || '';
  return form[LEGACY_EQUIPMENT_FIELDS[type].product] || '';
};

/** Serial for a slot: normalized row first, else legacy flat field. */
const equipmentSerial = (form, type) => {
  const row = equipmentRowFor(form, type);
  if (row) return row.serial_number || '';
  return form[LEGACY_EQUIPMENT_FIELDS[type].serial] || '';
};

/** Build the full ordered warranty.csv column list for the given resolved labels + language. */
const buildWarrantyColumns = (labels, language) => {
  const c = labels.columns;
  return [
    // ── General ──
    { header: c.id, value: (r) => r.id },
    { header: c.warrantyBookNumber, value: (r) => r.warranty_book_number },
    { header: c.warrantyStatus, value: (r) => translateEnum(labels.warrantyStatuses, r.status) },
    { header: c.createdAt, value: (r) => formatCsvDate(r.created_at, language, true) },
    { header: c.installationDate, value: (r) => formatCsvDate(r.installation_date, language, false) },
    // ── Installer / branch ──
    { header: c.installerFullName, value: (r) => r.installer_full_name },
    { header: c.installerPhone, value: (r) => r.installer_phone },
    { header: c.region, value: (r) => r.installer_region },
    { header: c.city, value: (r) => r.city },
    { header: c.district, value: (r) => r.installer_district },
    { header: c.branchName, value: (r) => r.installer_branch },
    { header: c.branchCode, value: (r) => r.installer_branch_code },
    { header: c.orgPhone, value: (r) => r.organization_phone },
    // ── Owner ──
    { header: c.ownerName, value: (r) => r.owner_full_name },
    { header: c.ownerPhone, value: (r) => r.owner_phone },
    // ── Vehicle ──
    { header: c.vehicle, value: (r) => resolveVehicleName(r) },
    { header: c.productionYear, value: (r) => r.vehicle_production_year },
    { header: c.plateNumber, value: (r) => r.vehicle_plate_number },
    { header: c.vin, value: (r) => r.vehicle_vin },
    { header: c.mileage, value: (r) => r.vehicle_mileage },
    { header: c.fuelType, value: (r) => translateEnum(labels.fuelTypes, r.fuel_type) },
    // ── Equipment (separate columns per slot; normalized row → legacy fallback) ──
    { header: c.reducerProduct, value: (r) => equipmentProduct(r, 'REDUCER') },
    { header: c.reducerSerial, value: (r) => equipmentSerial(r, 'REDUCER') },
    { header: c.cylinderProduct, value: (r) => equipmentProduct(r, 'CYLINDER') },
    { header: c.cylinderSerial, value: (r) => equipmentSerial(r, 'CYLINDER') },
    { header: c.controllerProduct, value: (r) => equipmentProduct(r, 'CONTROLLER') },
    { header: c.controllerSerial, value: (r) => equipmentSerial(r, 'CONTROLLER') },
    { header: c.injectorRailProduct, value: (r) => equipmentProduct(r, 'INJECTOR_RAIL') },
    { header: c.injectorRailSerial, value: (r) => equipmentSerial(r, 'INJECTOR_RAIL') },
    // ── EasyGas ──
    { header: c.easyGasSyncResult, value: (r) => translateEnum(labels.easyGasSyncResults, r.easygas_sync_result) },
    { header: c.easyGasClaimUrl, value: (r) => r.easygas_claim_url }, // verbatim URL (§23) — escaping handled centrally
    // ── Admin review ──
    { header: c.reviewedAt, value: (r) => formatCsvDate(r.reviewed_at, language, true) },
    { header: c.reviewNotes, value: (r) => r.review_notes },
    { header: c.reviewedBy, value: (r) => r.reviewed_by_name },
  ];
};

module.exports = { buildWarrantyColumns, equipmentProduct, equipmentSerial, EQUIPMENT_TYPES };
