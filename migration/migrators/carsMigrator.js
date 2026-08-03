/**
 * cars <- stag-db/cars.sql
 *
 *   id          -> external_id (idempotency key)
 *   name        -> model
 *   [brand_id]  -> brand (see lookups.CAR_BRAND_MAP — cars.brand_id points at
 *                  a car-manufacturer brands table that does not exist
 *                  anywhere in stag-db/; resolved by sampling model names)
 *   updated_at  -> external_updated_at (this column exists specifically for
 *                  "when did the source record last change")
 *   created_at / updated_at -> copied directly
 *
 * Ignored: name_ru, cylinders, power_hp, engine_volume, injection_type,
 * aspiration, image — EZONE's cars table is deliberately flat brand/model
 * text with no vehicle-fitment engineering concept at all.
 *
 * Generated: is_active=TRUE, synced_at=NULL (dead column).
 *
 * Rows whose brand_id is in UNRESOLVED_CAR_BRAND_IDS are skipped outright
 * (cars.brand is NOT NULL — there is nothing honest to put there).
 */

const path = require('path');
const { parseDumpFile } = require('../dumpParser');
const { CAR_BRAND_MAP, UNRESOLVED_CAR_BRAND_IDS } = require('../lookups');
const { withTransaction } = require('../withTransaction');

const STAG_DB_DIR = path.join(__dirname, '..', '..', '..', 'stag-db');

async function migrateCars(connection, reporter) {
  const filePath = path.join(STAG_DB_DIR, 'cars.sql');
  const statements = parseDumpFile(filePath).filter((s) => s.table === 'cars');

  const [existingRows] = await connection.execute('SELECT external_id FROM cars WHERE external_id IS NOT NULL');
  const existingExternalIds = new Set(existingRows.map((r) => r.external_id));

  for (const { record } of statements) {
    const externalId = String(record.id);

    if (existingExternalIds.has(externalId)) {
      reporter.skipped('cars', { external_id: externalId, model: record.name }, 'external_id already exists');
      continue;
    }
    if (UNRESOLVED_CAR_BRAND_IDS.has(record.brand_id)) {
      reporter.skipped('cars', { external_id: externalId, model: record.name, brand_id: record.brand_id }, 'brand_id could not be identified with confidence during analysis');
      continue;
    }

    const brand = CAR_BRAND_MAP[record.brand_id];
    if (!brand) {
      reporter.skipped('cars', { external_id: externalId, model: record.name, brand_id: record.brand_id }, 'brand_id not in CAR_BRAND_MAP — unexpected, a new id not seen during analysis');
      continue;
    }

    const { ok, error } = await withTransaction(connection, () => connection.execute(
      `INSERT INTO cars (external_id, brand, model, is_active, external_updated_at, synced_at, created_at, updated_at)
       VALUES (?, ?, ?, TRUE, ?, NULL, ?, ?)`,
      [externalId, brand, record.name, record.updated_at, record.created_at, record.updated_at]
    ));

    if (ok) {
      existingExternalIds.add(externalId);
      reporter.imported('cars', { external_id: externalId, brand, model: record.name });
    } else {
      reporter.failed('cars', { external_id: externalId, model: record.name }, error.message);
    }
  }
}

module.exports = { migrateCars };
