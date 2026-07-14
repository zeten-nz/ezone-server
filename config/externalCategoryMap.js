/**
 * Maps EasyGas's real product_category_id (from their public GET /products
 * catalog payload) to our products.category ENUM. This is NOT the same map
 * as config/equipmentCategories.js's EQUIPMENT_TYPE_TO_CATEGORIES — that file
 * maps our own 4 warranty equipment slots to the category values allowed in
 * each slot's local search UI; this one translates an external vendor's
 * taxonomy into our internal enum. The two must never be conflated.
 *
 * Confirmed by pulling all 179 real products across every page of
 * /public/api/products — `component_type` never existed; category is
 * `product_category_id` (stable numeric id) + `product_category_name`
 * (Uzbek label, translated in the comments below, used only for logging).
 * EasyGas's product catalog is their entire product line — the same real
 * pull also returned oils/coolant/hoses/fittings/accessories/repair kits —
 * so this whitelist is load-bearing, not cosmetic. Unmapped ids fail closed:
 * the sync service logs the id+name once and skips that product rather than
 * guessing or ever inserting 'OTHER' (see services/easyGasCatalogSyncService.js).
 *
 * Two categories seen in the real data were deliberately left unmapped
 * pending explicit confirmation, not guessed:
 *   - id 26 "Gaz klapanlari" (gas valves) — product names (VBE, MOON, LOV-0,
 *     "Zapravka ventili CNG") strongly resemble filling-valve model lines,
 *     but the category name itself is generic ("gas valve"), so it's not
 *     mapped to FILLING_VALVE without confirmation.
 *   - id 40 "Emulyatorlar" (injector emulators / fuel pump controllers) —
 *     genuine GBO conversion parts, but not one of the confirmed 8 equipment
 *     categories, so left out.
 */
const EXTERNAL_CATEGORY_MAP = {
  11: 'REDUCER',        // Reduktor
  28: 'CYLINDER',        // Gaz ballonlari
  4: 'CONTROLLER',       // Elektronika (every real sample was an ECU/control-unit model — STAG 300-6 QMAX, NEVO-SKY, TAPO, etc.)
  17: 'INJECTOR_RAIL',   // Forsunkalar
  23: 'MULTIVALVE',      // Multiklapanlar
  19: 'FILTER',          // Filtrlar
  38: 'PRESSURE_SENSOR', // Datchiklar (mostly pressure/MAP sensors; a couple of level/temp sensors also land here, closest available match)
};

const mapExternalCategory = (categoryId) => EXTERNAL_CATEGORY_MAP[categoryId] || null;

module.exports = { EXTERNAL_CATEGORY_MAP, mapExternalCategory };
