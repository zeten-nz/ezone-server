/**
 * Tracks progress for the 4-table migration and prints both live progress
 * (as each table runs) and a final structured summary. This is the single
 * place counting happens, so every migrator reports through the same shape
 * and nothing gets silently dropped.
 */

const TABLES = ['brands', 'branches', 'cars', 'products'];

function emptyBucket() {
  return { brands: [], branches: [], cars: [], products: [] };
}

function createReporter() {
  const counts = {};
  for (const table of TABLES) counts[table] = { imported: 0, skipped: 0, failed: 0 };

  const details = {
    imported: emptyBucket(),
    skipped: emptyBucket(),
    failed: emptyBucket(),
  };
  const warnings = [];
  const fatal = {}; // table -> error, for a whole step that couldn't even start

  return {
    startTable(table) {
      console.log(`\nImporting ${table}...`);
    },

    imported(table, info) {
      counts[table].imported++;
      details.imported[table].push(info);
    },

    skipped(table, info, reason) {
      counts[table].skipped++;
      const entry = { ...info, reason };
      details.skipped[table].push(entry);
      console.log(`  - skipped: ${JSON.stringify(entry)}`);
    },

    failed(table, info, errorMessage) {
      counts[table].failed++;
      const entry = { ...info, error: errorMessage };
      details.failed[table].push(entry);
      console.log(`  x failed: ${JSON.stringify(entry)}`);
    },

    /** A whole table's migration step could not run at all (e.g. dump file missing/unreadable). Distinct from a single failed row. */
    tableFatal(table, error) {
      fatal[table] = error.message;
      console.log(`  !! ${table} migration step aborted: ${error.message}`);
    },

    warn(message) {
      warnings.push(message);
      console.log(`  ! ${message}`);
    },

    finishTable(table) {
      const c = counts[table];
      console.log(`Imported: ${c.imported}`);
      console.log(`Skipped: ${c.skipped}`);
      console.log(`Failed: ${c.failed}`);
    },

    printFinalSummary() {
      console.log('\n=================================');
      console.log('Migration Complete');
      console.log('=================================');

      const labels = { brands: 'Brands', branches: 'Branches', cars: 'Cars', products: 'Products' };
      for (const table of TABLES) {
        const c = counts[table];
        console.log(`\n${labels[table]}`);
        if (fatal[table]) console.log(`  ABORTED: ${fatal[table]}`);
        console.log(`Imported: ${c.imported}`);
        console.log(`Skipped: ${c.skipped}`);
        console.log(`Failed: ${c.failed}`);
      }

      console.log(`\nWarnings: ${warnings.length}`);
      for (const w of warnings) console.log(`  - ${w}`);

      console.log('\nFinished.');
    },

    // Exposed for tests / programmatic inspection.
    _counts: counts,
    _details: details,
    _warnings: warnings,
    _fatal: fatal,
  };
}

module.exports = { createReporter };
