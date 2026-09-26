const text = (value) => value == null ? '' : String(value);
const meaningful = (value) => text(value).trim();

function vehicleParts(form) {
  if (form.catalog_car) return [text(form.catalog_car.brand), text(form.catalog_car.model)];
  if (meaningful(form.vehicle_brand) && meaningful(form.vehicle_model)) {
    return [text(form.vehicle_brand), text(form.vehicle_model)];
  }
  const tokens = meaningful(form.vehicle_name).split(/\s+/);
  return tokens.length > 1 ? [tokens.shift(), tokens.join(' ')] : ['', ''];
}

function excelDate(value) {
  if (!value) return null;
  // The database pool uses timezone +00:00; strings are YYYY-MM-DD.
  const parts = value instanceof Date
    ? [value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()]
    : /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(String(value))?.slice(1, 4).map(Number);
  if (!parts) return null;
  const [y, m, d] = parts;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

function equipment(form, type, legacy) {
  const row = (form.equipment || []).find((item) => item.equipment_type === type);
  const brand = row ? meaningful(row.product_brand) || meaningful(row.brand_name) || text(form[`${legacy}_manufacturer`]) : text(form[`${legacy}_manufacturer`]);
  const raw = row ? row.serial_numbers ?? row.serial_number : form[`${legacy}_serial_number`];
  const serials = (Array.isArray(raw) ? raw : text(raw).split(',')).map(meaningful).filter(Boolean).join(', ');
  return { exists: Boolean(row || brand || serials), brand, country: row?.product_id ? text(row.product_brand_country) : '', serials };
}

// Exactly A:AH. B is the branch's STAG service code, never the warranty row ID.
function mapClientWarranty(form) {
  const [brand, model] = vehicleParts(form);
  const r = equipment(form, 'REDUCER', 'reducer');
  const c = equipment(form, 'CYLINDER', 'cylinder');
  const e = equipment(form, 'CONTROLLER', 'stag_controller');
  const i = equipment(form, 'INJECTOR_RAIL', 'injector_rail');
  return {
    A: '', B: text(form.installer_branch_code), C: text(form.installer_region), D: text(form.city),
    E: text(form.installer_district), F: text(form.installer_branch), G: text(form.owner_phone), H: text(form.owner_full_name),
    I: text(form.warranty_book_number), J: excelDate(form.installation_date), K: brand, L: model,
    M: text(form.vehicle_production_year), N: text(form.vehicle_plate_number), O: text(form.vehicle_vin),
    P: text(form.vehicle_engine_volume), Q: text(form.vehicle_engine_power), R: text(form.vehicle_mileage),
    S: text(form.installer_full_name), T: text(form.installer_phone), U: text(form.fuel_type), V: r.brand, W: r.country, X: r.serials,
    Y: c.exists ? text(form.fuel_type) : '', Z: c.brand, AA: c.country, AB: c.serials,
    AC: e.brand, AD: e.country, AE: e.serials, AF: i.brand, AG: i.country, AH: i.serials,
  };
}

module.exports = { mapClientWarranty, vehicleParts, excelDate };
