const { validationResult } = require('express-validator');
const { pool } = require('../config/database');
const warrantyRepository = require('../repositories/warrantyRepository');
const { attachEquipment } = require('../utils/warrantyEquipment');

/**
 * Maps one attached equipment row (warranty_equipment joined to products,
 * see repositories/equipmentRepository.js's findByWarrantyFormIds) to the
 * flat shape this endpoint promises. `barcode` and `serial_number` are
 * deliberately the same value: this data model has exactly one column for
 * "the physical unit's identifying code" (warranty_equipment.serial_number
 * — populated from inventory_items.barcode at claim time for barcode-
 * tracked installs, or typed directly for legacy/untracked ones); there is
 * no second, distinct barcode column to report separately.
 */
const toProductResponse = (row) => ({
  product_name: row.product_name,
  category: row.product_category || row.equipment_type,
  fuel_type: row.fuel_type,
  barcode: row.serial_number,
  serial_number: row.serial_number,
});

/**
 * Maps one warranty_forms row (with equipment attached) to the flat,
 * snake_case shape this endpoint promises — deliberately not the nested
 * `installer: {...}` shape warrantyDTO.js's toWarrantyResponse uses for the
 * admin/employee UI, since the caller here asked for direct column-name
 * fields, not that internal API's shape. `fuel_type` is one value per
 * warranty in this data model (warranty_forms.fuel_type, resolved via the
 * same FUEL_TYPE_SELECT/FUEL_TYPE_JOIN fallback every other read path
 * uses) — every product in the array shares it, since there is no
 * per-product fuel type column.
 */
const toCustomerWarrantyResponse = (form) => ({
  id: form.id,
  warranty_number: form.easygas_warranty_number,
  installation_date: form.installation_date,
  created_at: form.created_at,
  easygas_sync_status: form.easygas_sync_status,

  owner_full_name: form.owner_full_name,
  owner_phone: form.owner_phone,
  vehicle_name: form.vehicle_name,
  vehicle_brand: form.vehicle_brand,
  vehicle_model: form.vehicle_model,
  vehicle_plate_number: form.vehicle_plate_number,
  vehicle_vin: form.vehicle_vin,
  vehicle_production_year: form.vehicle_production_year,
  vehicle_mileage: form.vehicle_mileage,

  installer_full_name: form.installer_full_name,
  installer_phone: form.installer_phone,
  installer_branch: form.installer_branch,

  products: (form.equipment || []).map((row) => ({ ...toProductResponse(row), fuel_type: form.fuel_type })),
});

/**
 * POST /api/public/customer/warranties — called by the partner platform
 * that owns customer authentication; we receive only a phone number,
 * already verified on their side, and search exactly by
 * warranty_forms.owner_phone. Never accepts or trusts any identity from a
 * token — there is no customer JWT, by design (see the architecture
 * review this endpoint was designed against).
 */
const getWarrantiesByPhone = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const { phone } = req.body;
    const connection = await pool.getConnection();
    let forms;
    try {
      const rows = await warrantyRepository.findByOwnerPhone(connection, phone);
      forms = await attachEquipment(connection, rows);
    } finally {
      connection.release();
    }

    if (forms.length === 0) {
      return res.json({ success: true, hasWarranty: false, count: 0, data: [] });
    }

    res.json({
      success: true,
      hasWarranty: true,
      count: forms.length,
      data: forms.map(toCustomerWarrantyResponse),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getWarrantiesByPhone };
