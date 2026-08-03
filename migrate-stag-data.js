/**
 * ONE-TIME historical data migration: legacy STAG/EasyGas platform dump
 * (stag-db/*.sql, database `cf02795_easygasv2`) -> EZONE's live schema.
 *
 * This is NOT a SQL import and does NOT touch EZONE's schema in any way:
 * no CREATE TABLE, no ALTER TABLE, no DROP TABLE, and the dump files'
 * own INSERT statements are never executed directly either. Every table's
 * migrator (migration/migrators/*.js) reads the dumps' literal row values
 * through migration/dumpParser.js, transforms them per the mapping rules
 * in migration/lookups.js + migration/addressParser.js, and writes them
 * through brand-new, parameterized INSERT statements built against EZONE's
 * existing schema — using the exact same pool every controller/repository
 * in this app already uses (config/database.js).
 *
 * Idempotent: every migrator checks for an existing row first (branches by
 * `code`, brands/cars/products by `external_id`) before inserting, so
 * running this script a second time only processes whatever is still
 * missing — nothing is duplicated.
 *
 * This script is NEVER invoked by server.js, initializeDatabase(), PM2, a
 * cron job, or any other automated path — it only runs when explicitly
 * executed by hand:
 *
 *   cd ezone-server
 *   node migrate-stag-data.js
 *
 * Take a `mysqldump` backup before running this against production.
 *
 * Dependency order (products.brand_id resolves through brands, so brands
 * must be migrated first): brands -> branches -> cars -> products.
 */

require('dotenv').config();

const { pool } = require('./config/database');
const { createReporter } = require('./migration/reporter');
const { migrateBrands } = require('./migration/migrators/brandsMigrator');
const { migrateBranches } = require('./migration/migrators/branchesMigrator');
const { migrateCars } = require('./migration/migrators/carsMigrator');
const { migrateProducts } = require('./migration/migrators/productsMigrator');

/** Runs one migration step, reporting a table-wide abort (e.g. dump file missing/unreadable) distinctly from a single failed row, without stopping the rest of the script. */
async function runStep(reporter, table, stepFn) {
  reporter.startTable(table);
  let result;
  try {
    result = await stepFn();
  } catch (error) {
    reporter.tableFatal(table, error);
    result = undefined;
  }
  reporter.finishTable(table);
  return result;
}

async function migrate() {
  const reporter = createReporter();
  const connection = await pool.getConnection();

  try {
    const oldBrandIdToName = (await runStep(reporter, 'brands', () => migrateBrands(connection, reporter))) || {};

    await runStep(reporter, 'branches', () => migrateBranches(connection, reporter));

    await runStep(reporter, 'cars', () => migrateCars(connection, reporter));

    await runStep(reporter, 'products', () => migrateProducts(connection, reporter, oldBrandIdToName));
  } finally {
    connection.release();
  }

  reporter.printFinalSummary();
}

migrate()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[migrate-stag-data] Fatal error:', error);
    process.exit(1);
  });
