const warrantyRepository = require('./warrantyRepository');

async function findChunk(connection, filters) {
  const forms = await warrantyRepository.findChunkForExport(connection, filters);
  if (!forms.length) return forms;
  const ids = forms.map((form) => form.id);
  const [equipment] = await connection.execute(
    `SELECT we.*, p.brand AS product_brand, b.country AS product_brand_country
     FROM warranty_equipment we LEFT JOIN products p ON p.id = we.product_id
     LEFT JOIN brands b ON b.id = p.brand_id
     WHERE we.warranty_form_id IN (${ids.map(() => '?').join(',')})`, ids);
  const carIds = [...new Set(forms.map((form) => form.car_id).filter(Boolean))];
  const [cars] = carIds.length ? await connection.execute(
    `SELECT id, brand, model FROM cars WHERE id IN (${carIds.map(() => '?').join(',')})`, carIds) : [[]];
  const byCar = new Map(cars.map((car) => [car.id, car]));
  const byForm = new Map();
  for (const row of equipment) {
    if (!byForm.has(row.warranty_form_id)) byForm.set(row.warranty_form_id, []);
    byForm.get(row.warranty_form_id).push(row);
  }
  return forms.map((form) => ({ ...form, catalog_car: byCar.get(form.car_id), equipment: byForm.get(form.id) || [] }));
}

module.exports = { findChunk };
