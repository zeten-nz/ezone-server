const equipmentRepository = require('../repositories/equipmentRepository');

/**
 * Batched (not N+1) attach of each warranty's 4 equipment rows — replaces
 * the old attachProducts (which queried warranty_form_products, superseded
 * by warranty_equipment). Shared by warrantyController's read paths and
 * excelController so this join logic lives in exactly one place.
 */
const attachEquipment = async (connection, forms) => {
  if (forms.length === 0) return forms;
  const formIds = forms.map((f) => f.id);
  const rows = await equipmentRepository.findByWarrantyFormIds(connection, formIds);

  const byForm = new Map();
  for (const row of rows) {
    if (!byForm.has(row.warranty_form_id)) byForm.set(row.warranty_form_id, []);
    byForm.get(row.warranty_form_id).push(row);
  }
  return forms.map((f) => ({ ...f, equipment: byForm.get(f.id) || [] }));
};

module.exports = { attachEquipment };
