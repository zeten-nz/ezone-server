/**
 * branches <- stag-db/branches.sql
 *
 *   stag_code               -> code (idempotency key)
 *   name                    -> name
 *   first_additional_field  -> phone (confirmed by data: holds real phone numbers, not a generic field)
 *   status === 'recommended' -> is_active (verified: all 259 rows have this exact value)
 *   created_at / updated_at -> copied directly
 *   [stag_code prefix]      -> region  (see lookups.regionFromStagCode)
 *   [address text]          -> district, city (see addressParser.parseAddress)
 *
 * Ignored: name_ru, description(_ru), address_ru, address_link, lat, lng,
 * image, second_additional_field(_ru), timezone (constant), region_id
 * (superseded by the stag_code-prefix lookup, which is more reliable than
 * an ID with no label table behind it).
 *
 * Generated: easygas_stag_code is deliberately left untouched — it's a
 * documented DEAD column in EZONE (config/database.js), and populating it
 * would just recreate the exact legacy coupling that was already removed.
 */

const path = require('path');
const { parseDumpFile } = require('../dumpParser');
const { parseAddress } = require('../addressParser');
const { regionFromStagCode } = require('../lookups');
const { withTransaction } = require('../withTransaction');

const STAG_DB_DIR = path.join(__dirname, '..', '..', '..', 'stag-db');

async function migrateBranches(connection, reporter) {
  const filePath = path.join(STAG_DB_DIR, 'branches.sql');
  const statements = parseDumpFile(filePath).filter((s) => s.table === 'branches');

  const [existingRows] = await connection.execute('SELECT code FROM branches');
  const existingCodes = new Set(existingRows.map((r) => r.code));

  for (const { record } of statements) {
    const code = record.stag_code;

    if (!code) {
      reporter.skipped('branches', { id: record.id, name: record.name }, 'no stag_code to use as EZONE code');
      continue;
    }
    if (existingCodes.has(code)) {
      reporter.skipped('branches', { code, name: record.name }, 'code already exists');
      continue;
    }

    const region = regionFromStagCode(code);
    const { district, city } = parseAddress(record.address);
    const phone = record.first_additional_field || null;

    const isActive = record.status === 'recommended';
    if (record.status !== 'recommended') {
      reporter.warn(`branches: code ${code} has unexpected status '${record.status}' (every other row is 'recommended') — defaulted is_active=false, review manually`);
    }
    if (!region) {
      reporter.warn(`branches: code ${code} has an unrecognized stag_code prefix — region left NULL, review manually`);
    }
    if (!district && !city) {
      reporter.warn(`branches: code ${code} — could not parse district/city from address "${record.address}"`);
    }

    const { ok, error } = await withTransaction(connection, () => connection.execute(
      `INSERT INTO branches (code, name, phone, region, district, city, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code, record.name, phone, region, district, city, isActive, record.created_at, record.updated_at]
    ));

    if (ok) {
      existingCodes.add(code);
      reporter.imported('branches', { code, name: record.name, region, district, city });
    } else {
      reporter.failed('branches', { code, name: record.name }, error.message);
    }
  }
}

module.exports = { migrateBranches };
