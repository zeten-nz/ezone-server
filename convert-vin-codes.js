/**
 * Standalone converter: supplier "Product / Source boxes / VIN Codes" TXT
 * export (see vin-codes/*.txt) -> a CSV ready for direct upload through the
 * existing Inventory Import page (POST /api/inventory/import). Produces a
 * file only — never calls the endpoint, never touches the database.
 *
 * Only the "VIN Codes:" section is real data. Everything before it
 * (Product:, Source boxes: and its range/pcs documentation lines) is
 * ignored completely, per spec.
 *
 * Reuses inventoryService.isValidBarcode — the SAME rule the import
 * endpoint itself validates against — instead of a separate regex, so a
 * code this script accepts can never be rejected by the importer, and vice
 * versa. Nothing in services/, repositories/, routes/, or controllers/ is
 * touched by this file.
 *
 * Usage (from ezone-server/):
 *   node convert-vin-codes.js <input.txt>
 * Output is always written next to the input file, same basename, .csv
 * extension (e.g. TOMASETTO_AT09_NORDIC_XP.txt -> TOMASETTO_AT09_NORDIC_XP.csv).
 */

const fs = require('fs');
const path = require('path');
const { isValidBarcode } = require('./services/inventoryService');

const VIN_SECTION_MARKER = 'vin codes:';

/**
 * Whole-file-in-memory, not streamed — deliberately matching this project's
 * own existing convention for this exact class of data: the import
 * endpoint's own parser (utils/csvBarcodeParser.js) reads the entire
 * multer-buffered file via csv-parse/SYNC, not a stream, for the same kind
 * of bare barcode/serial list. Even a 20,000-VIN file (~180 KB) is trivial
 * for Node to hold fully in memory — streaming would add complexity this
 * data size doesn't need.
 */
function convertVinCodesFile(inputPath) {
  const text = fs.readFileSync(inputPath, 'utf8');
  const lines = text.split(/\r?\n/);

  const markerIndex = lines.findIndex((line) => line.trim().toLowerCase() === VIN_SECTION_MARKER);
  if (markerIndex === -1) {
    console.warn(`WARNING: no "VIN Codes:" section found in ${inputPath} — scanning the whole file instead.`);
  }
  const candidateLines = markerIndex === -1 ? lines : lines.slice(markerIndex + 1);

  const seen = new Set();
  const vinCodes = [];
  const invalidVins = [];
  let totalFound = 0;
  let duplicateCount = 0;

  for (const rawLine of candidateLines) {
    const line = rawLine.trim();
    if (line === '') continue; // blank lines are not VIN entries — not counted, not reported

    totalFound += 1;

    if (!isValidBarcode(line)) {
      invalidVins.push(line);
      continue;
    }
    if (seen.has(line)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(line);
    vinCodes.push(line);
  }

  return {
    vinCodes,
    stats: {
      totalFound,
      duplicatesRemoved: duplicateCount,
      invalidRemoved: invalidVins.length,
      invalidVins,
      finalRows: vinCodes.length,
    },
  };
}

/** No quotes, no numbering, no extra columns, no empty rows — exactly `vin_code` + one bare code per line. */
function writeCsv(vinCodes, outputPath) {
  const content = ['vin_code', ...vinCodes].join('\n') + '\n';
  fs.writeFileSync(outputPath, content, 'utf8'); // utf8, no BOM
}

function printReport(inputPath, outputPath, stats) {
  console.log(`Input file: ${inputPath}`);
  console.log(`Output file: ${outputPath}`);
  console.log(`Total VINs found: ${stats.totalFound}`);
  console.log(`Duplicates removed: ${stats.duplicatesRemoved}`);
  console.log(`Invalid VINs removed: ${stats.invalidRemoved}`);
  console.log(`Final CSV rows: ${stats.finalRows}`);
  if (stats.invalidVins.length > 0) {
    console.log('Invalid VINs:');
    for (const vin of stats.invalidVins) console.log(`  ${vin}`);
  }
}

function main() {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error('Usage: node convert-vin-codes.js <input.txt>');
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  const outputPath = inputPath.replace(/\.txt$/i, '.csv');

  const { vinCodes, stats } = convertVinCodesFile(inputPath);
  writeCsv(vinCodes, outputPath);
  printReport(inputPath, outputPath, stats);
}

if (require.main === module) {
  main();
}

module.exports = { convertVinCodesFile, writeCsv };
