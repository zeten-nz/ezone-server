/**
 * Maps EasyGas's real product_category_id (from their public GET /products
 * catalog payload) to our products.category ENUM. This is NOT the same map
 * as config/equipmentCategories.js's EQUIPMENT_TYPE_TO_CATEGORIES — that file
 * maps our own 4 warranty equipment slots to the category values allowed in
 * each slot's local search UI; this one translates an external vendor's
 * taxonomy into our internal enum. The two must never be conflated.
 *
 * CORRECTION to an earlier version of this comment: EasyGas's
 * /public/api/products endpoint does NOT pre-filter server-side — a live
 * call returns their entire product line (207 products across 15 real
 * categories confirmed live: hoses, oils/fluids, accessories, sensors,
 * fittings, emulators, gas valves, tubes, multivalves, repair kits, filters,
 * plus these 4). This map is what actually does the filtering, entirely
 * client-side: mapExternalCategory returns null for the other 11 categories,
 * and upsertProduct (services/easyGasCatalogSyncService.js) skips any
 * product that maps to null. A live pull confirmed this map is exactly
 * right as-is — the 4 ids below matched precisely, with the exact same
 * Uzbek category names shown in the inline comments, and every one of the
 * other 123 returned products fell into one of the 11 unmapped categories.
 * No wider whitelist is being restored — the 4 categories here are still
 * the only ones warranty products can come from — but if EasyGas ever adds
 * a 5th warranty-relevant category, this map (not server-side filtering)
 * is the one place that would need updating.
 *
 * category id → ENUM mapping independently re-confirmed against a live
 * /public/api/products pull; product_category_id is the stable numeric
 * field (product_category_name is the Uzbek label, logging only). Unmapped
 * ids fail closed: the sync service logs the id+name once and skips that
 * product rather than guessing or ever inserting 'OTHER' (see
 * services/easyGasCatalogSyncService.js) — this is the real, routine
 * filtering path (not a rare defensive safety net, as an earlier version of
 * this comment characterized it — 123 of 207 live products hit it).
 */
const EXTERNAL_CATEGORY_MAP = {
  11: 'REDUCER',        // Reduktor
  4: 'CONTROLLER',       // Elektronika (every real sample was an ECU/control-unit model — STAG 300-6 QMAX, NEVO-SKY, TAPO, etc.)
  17: 'INJECTOR_RAIL',   // Forsunkalar
  28: 'CYLINDER',        // Gaz ballonlari
};

const mapExternalCategory = (categoryId) => EXTERNAL_CATEGORY_MAP[categoryId] || null;

module.exports = { EXTERNAL_CATEGORY_MAP, mapExternalCategory };
