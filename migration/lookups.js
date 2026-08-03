/**
 * Every lookup table in this file was built by exhaustively parsing the
 * actual stag-db/*.sql dumps first (not guessed from column names) — see
 * the migration-analysis conversation this script was produced from for
 * the row-by-row evidence behind each mapping. Re-verified by
 * migration/__verify__.js before this file was finalized.
 */

// ============================================================================
// branches.region_id -> EZONE region name
// ----------------------------------------------------------------------------
// branches.sql has no `regions` table (missing from stag-db/ entirely), but
// every branch's `stag_code` prefix (the part before "/") maps 1:1 to a
// region_id, and every one of the 13 region_id values actually present in
// the dump (1,2,3,4,5,6,7,9,10,11,12,15,16 — confirmed exhaustively across
// all 259 rows; no 8/13/14 rows exist) was cross-referenced against that
// region's own address text. Complete — no unresolved region.
// ============================================================================
const REGION_BY_CODE_PREFIX = {
  '01': "Toshkent shahar",
  '10': "Toshkent viloyati",
  '20': "Sirdaryo viloyati",
  '30': "Samarqand viloyati",
  '40': "Farg'ona viloyati",
  '50': "Namangan viloyati",
  '60': "Andijon viloyati",
  '70': "Qashqadaryo viloyati",
  '75': "Surxondaryo viloyati",
  '80': "Buxoro viloyati",
  '85': "Navoiy viloyati",
  '90': "Xorazm viloyati",
  '95': "Qoraqalpog'iston Respublikasi",
};

/** Resolves a branch's region from its own stag_code prefix (e.g. "20/5" -> "Sirdaryo viloyati"). Returns null for an unrecognized prefix (none observed in practice). */
function regionFromStagCode(stagCode) {
  const prefix = (stagCode || '').split('/')[0];
  return REGION_BY_CODE_PREFIX[prefix] || null;
}

// ============================================================================
// products.product_category_id -> EZONE products.category
// ----------------------------------------------------------------------------
// product_categories.sql (the file that would supply category labels) is
// missing from stag-db/ entirely. Every one of the 15 distinct
// product_category_id values actually present in products.sql (confirmed
// across all 179 rows) was resolved by sampling that category's real
// product names (STAG/LandiRenzo/etc. equipment model numbers) against
// EZONE's fixed category ENUM. category 41 has no equivalent in EZONE's
// warranty-equipment catalog at all and is excluded outright below, not
// force-mapped into a wrong bucket.
// ============================================================================
const CATEGORY_MAP = {
  4: 'CONTROLLER',     // STAG-200/400/500/DIESEL — ECU/control units
  11: 'REDUCER',       // CN04, R01/R02/R14, RGJ, NG2, AT09/AT12/AT20 — LPG reducers
  17: 'INJECTOR_RAIL', // FENIX, IG7 Dakota, W01/W02/W03 — injector rail systems
  19: 'FILTER',        // F779/C, FL01S, Bulpren, TMSP — gas phase filters
  20: 'OTHER',         // hoses/tubing (antifreeze/gas/vacuum hose) — no dedicated EZONE category
  23: 'CYLINDER',      // AT00 Sprint toroidal/cylindrical tanks (explicit dimensions h./d.)
  24: 'OTHER',         // fittings/manifolds (troynik, kollektor, burchakli) — mounting hardware
  26: 'FILLING_VALVE', // solenoid gas valve, CNG filling valve, multivalve fitting parts
  28: 'CYLINDER',      // CNG toroidal cylinders (explicit liter capacities)
  30: 'OTHER',         // plastic tubing (FARO plastik quvur/trubka)
  37: 'REDUCER',       // R14 (metan), AT09/AT12 (CNG) — CNG-variant reducers
  38: 'PRESSURE_SENSOR', // gas level sensor, reducer temperature sensor
  39: 'CONTROLLER',    // Bluetooth/USB/switches/heaters — ECU accessory electronics (medium confidence)
  40: 'INJECTOR_RAIL', // FPE-A/FPC/ISR/HPPE/EZP1 — injector emulator hardware (medium confidence)
  // 41 intentionally absent: SAE motor oils + Tosol/antifriz coolant — not
  // gas-conversion equipment at all. Rows in this category are skipped, not
  // force-mapped into OTHER.
};
const EXCLUDED_CATEGORY_IDS = new Set([41]);

// ============================================================================
// cars.brand_id -> car manufacturer name
// ----------------------------------------------------------------------------
// cars.brand_id points at a *separate* car-manufacturer brands table that
// does not exist anywhere in stag-db/ (confirmed: these ids range up to 80,
// while product_brands.sql — a completely different, LPG/CNG-equipment
// brand table — only defines ids 1-32). Every one of the 41 distinct
// brand_id values in cars.sql (confirmed across all 409 rows) was identified
// by sampling that id's actual car model names. Two could not be identified
// with confidence and are excluded below — rows referencing them are
// skipped, not guessed.
// ============================================================================
const CAR_BRAND_MAP = {
  11: 'Chevrolet', 12: 'Hyundai', 13: 'BYD', 15: 'Kia', 16: 'Chery',
  17: 'Changan', 18: 'JAC', 19: 'Mercedes-Benz', 21: 'Jetour', 22: 'DFSK',
  23: 'Honda', 24: 'Hongqi', 25: 'Skoda', 27: 'Toyota', 28: 'Lexus',
  29: 'Lada', 30: 'BMW', 32: 'Haval', 33: 'Nissan', 34: 'Renault',
  35: 'Volkswagen', 36: 'Volvo', 42: 'Audi', 43: 'Cadillac', 47: 'Ford',
  48: 'FAW', 51: 'GMC', 55: 'Infiniti', 58: 'Jeep', 61: 'Land Rover',
  62: 'Li Auto', 63: 'Mazda', 64: 'Mitsubishi', 68: 'Opel', 70: 'Porsche',
  73: 'Subaru', 74: 'Suzuki', 79: 'SsangYong', 80: 'Zotye',
  // 26 ("T5 Evo Hybrid" only) and 46 ("Tundland G9"/"Miller" only) — a single
  // unrecognized model each, not enough evidence to name the brand.
};
const UNRESOLVED_CAR_BRAND_IDS = new Set([26, 46]);

module.exports = {
  REGION_BY_CODE_PREFIX,
  regionFromStagCode,
  CATEGORY_MAP,
  EXCLUDED_CATEGORY_IDS,
  CAR_BRAND_MAP,
  UNRESOLVED_CAR_BRAND_IDS,
};
