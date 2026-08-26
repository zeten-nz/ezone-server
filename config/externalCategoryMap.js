/**
 * Maps EasyGas's real product_category_id (from the signed GET
 * {base}/products integration endpoint — see easyGasCatalogClient.js) to
 * our products.category ENUM. This is NOT the same map as
 * config/equipmentCategories.js's EQUIPMENT_TYPE_TO_CATEGORIES — that file
 * maps our own 4 warranty equipment slots to the category values allowed in
 * each slot's local search UI; this one translates an external vendor's
 * taxonomy into our internal enum. The two must never be conflated.
 *
 * The endpoint does NOT pre-filter server-side — it returns EasyGas's
 * entire product line (hoses, oils/fluids, accessories, sensors, fittings,
 * emulators, gas valves, tubes, multivalves, repair kits, filters, plus
 * these 4). This map is what actually does the filtering, entirely
 * client-side: mapExternalCategory returns null for every other category,
 * and upsertProduct (services/easyGasCatalogSyncService.js) skips any
 * product that maps to null — the real, routine filtering path, not a rare
 * defensive safety net. The 4 ids below were confirmed against live pulls
 * of the old endpoint (exact Uzbek labels in the inline comments) and id 4
 * = CONTROLLER was re-confirmed on the NEW endpoint's production probe
 * (2026-08-26: id 215 "STAG-200 GoFast-4", product_category_id 4,
 * component_type "controller"). product_category_id is the stable numeric
 * key; the probe-confirmed component_type string is diagnostics-only. No
 * wider whitelist: these 4 categories are the only ones warranty products
 * can come from — if EasyGas ever adds a 5th warranty-relevant category,
 * this map (not server-side filtering) is the one place to update. Unmapped
 * ids fail closed: logged once, skipped, never guessed or inserted 'OTHER'.
 */
const EXTERNAL_CATEGORY_MAP = {
  11: 'REDUCER',        // Reduktor
  4: 'CONTROLLER',       // Elektronika (every real sample was an ECU/control-unit model — STAG 300-6 QMAX, NEVO-SKY, TAPO, etc.)
  17: 'INJECTOR_RAIL',   // Forsunkalar
  28: 'CYLINDER',        // Gaz ballonlari
};

const mapExternalCategory = (categoryId) => EXTERNAL_CATEGORY_MAP[categoryId] || null;

module.exports = { EXTERNAL_CATEGORY_MAP, mapExternalCategory };
