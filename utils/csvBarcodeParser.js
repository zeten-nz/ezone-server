/**
 * Extracts the barcode column from a real-world CSV/TXT inventory import
 * file — Excel/LibreOffice-style exports (BOM, CRLF, quoted, delimited,
 * multi-column) and the original bare one-barcode-per-line TXT format both
 * go through this same path. Pure parsing/column-detection only: barcode
 * *value* validity (character-set rules) stays entirely in
 * services/inventoryService.js's isValidBarcode, which this module never
 * touches or duplicates — it only ever returns candidate strings, exactly
 * like the parseBarcodeLines function it replaces.
 */
const { parse } = require('csv-parse/sync');

// csv-parse's own delimiter_auto (v7.0.1) cannot handle quoted fields at
// all — it throws "Invalid Closing/Opening Quote" on any quoted CSV,
// comma- or semicolon-delimited, with or without a BOM (confirmed by
// direct testing against the installed package, not assumed from docs).
// Real Excel/LibreOffice exports are routinely quoted, so delimiter_auto
// is not usable here. Instead: try each candidate delimiter through
// csv-parse's normal (correctly quote-aware) parser, and keep whichever
// produces the widest header row — this still leverages the library's
// real RFC4180 engine for the actual parsing; only the 3-way delimiter
// *choice* is hand-rolled, not CSV structure itself.
const CANDIDATE_DELIMITERS = [',', ';', '\t'];

const parseWithBestDelimiter = (buffer) => {
  let best = null;
  for (const delimiter of CANDIDATE_DELIMITERS) {
    let records;
    try {
      records = parse(buffer, {
        bom: true,
        encoding: 'utf8',
        delimiter,
        trim: true,
        skip_empty_lines: true,
        relax_column_count: true, // real exports are rarely perfectly uniform column-to-column
        columns: false,            // raw arrays — header/column detection happens separately below
        cast: false,               // never let a numeric-looking barcode ("0012345") become a
                                    // JS Number and lose its leading zeros
      });
    } catch {
      continue; // this delimiter produced an invalid structure (e.g. broken quoting) — try the next
    }
    const columnCount = records.length > 0 ? records[0].length : 0;
    if (best === null || columnCount > best.columnCount) {
      best = { records, columnCount };
    }
  }
  if (best === null) {
    // Only reachable if every single candidate delimiter throws — e.g. a
    // file with a genuinely unbalanced quote. Retry once with the first
    // candidate to surface a real, readable csv-parse error to the caller
    // instead of a silent empty result.
    return parse(buffer, { bom: true, encoding: 'utf8', delimiter: CANDIDATE_DELIMITERS[0], trim: true, skip_empty_lines: true, relax_column_count: true, columns: false, cast: false });
  }
  return best.records;
};

// Checked first — this system tracks physical units by barcode
// (inventory_items.barcode), so if a file has both a "Barcode" and a
// "Serial Number" column, the barcode column is the correct one to import.
// 'vin' is included here, not as a separate tier: a supplier-issued VIN
// code (e.g. from the vin-codes/ TXT exports) IS the barcode value for this
// system — it's stored in inventory_items.barcode like any other, never a
// distinct concept. Deliberately no bare 'sn'/'id'/'no'/'number' — too
// short/generic, real risk of matching an unrelated header, or worse,
// matching real barcode *data* in a headerless file (e.g. a barcode
// literally starting "SN-").
const BARCODE_HEADER_KEYWORDS = ['barcode', 'bar code', 'vin', 'штрихкод', 'shtrix'];

// Checked only if no cell matched a barcode-tier keyword.
const SERIAL_HEADER_KEYWORDS = ['serial', 'серийный', 'seriya'];

/** Returns the index of the first header cell matching a known barcode/
 * serial keyword (barcode-tier checked before serial-tier), or -1 if the
 * row doesn't look like a header at all. Cyrillic keywords can only ever
 * match a real header cell — isValidBarcode never accepts Cyrillic, so a
 * genuine barcode value can't produce a false positive here. */
const detectBarcodeColumnIndex = (headerRow) => {
  for (const keywords of [BARCODE_HEADER_KEYWORDS, SERIAL_HEADER_KEYWORDS]) {
    const index = headerRow.findIndex((cell) => keywords.some((keyword) => cell.toLowerCase().includes(keyword)));
    if (index !== -1) return index;
  }
  return -1;
};

/**
 * `buffer` is the raw uploaded file (multer memoryStorage — never written
 * to disk). Returns an ordered array of trimmed candidate strings, one per
 * data row, with the header row (if recognized) and fully-blank rows
 * already excluded — the exact same shape/contract the old
 * parseBarcodeLines + inline header-slice produced, so importCsv's
 * downstream dedup/insert logic needs no changes at all.
 */
const extractBarcodeCandidates = (buffer) => {
  const rawRecords = parseWithBestDelimiter(buffer);

  // "Completely empty row" means every column is blank — broader than
  // skip_empty_lines above (which only drops zero-length raw lines, not a
  // spreadsheet's stray ",,," trailing row). Applied BEFORE header
  // detection so a stray blank row above the real header can't defeat it.
  const records = rawRecords.filter((record) => !record.every((field) => field === ''));
  if (records.length === 0) return [];

  const headerColumnIndex = detectBarcodeColumnIndex(records[0]);
  const hasHeader = headerColumnIndex !== -1;
  const columnIndex = hasHeader ? headerColumnIndex : 0;
  const dataRecords = hasHeader ? records.slice(1) : records;

  return dataRecords.map((record) => (record[columnIndex] !== undefined ? record[columnIndex] : ''));
};

module.exports = { extractBarcodeCandidates, detectBarcodeColumnIndex };
