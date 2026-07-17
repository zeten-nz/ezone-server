/**
 * Shared CSV-streaming helper for Phase 4's exports. Uses keyset pagination
 * (`fetchChunk(lastId, limit) => rows`), not OFFSET — OFFSET shifts under
 * concurrent writes (rows inserted mid-export skip/duplicate across chunk
 * boundaries), keyset doesn't, since new rows always get a higher id and
 * never appear before the cursor. Each chunk is written to the response as
 * soon as it's fetched — nothing ever holds the full result set in memory,
 * satisfying "must stream large datasets, do not load everything into
 * memory" for genuinely large tables (inventory/warranty/points), the
 * explicit requirement behind this being CSV+streaming rather than the
 * existing in-memory XLSX pattern (see the Phase 4 plan's D6).
 */

// OWASP CSV Injection guidance: a cell whose first character is one of
// these can be interpreted as a formula (or a DDE launch, for '=') by
// Excel/LibreOffice/Sheets when the export is opened. Exported cells carry
// user-supplied free text (owner_full_name, manual point-adjustment
// reason, ...), so this must be applied unconditionally to every cell, not
// just ones that "look like" an attack — prefixing with a single quote is
// the standard mitigation: it forces the cell to render as literal text
// instead of being evaluated, at the accepted cost that a legitimate value
// which happens to start with one of these (e.g. a negative number) also
// renders as text rather than a native number in the spreadsheet app.
const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

const escapeCsvField = (value) => {
  if (value === null || value === undefined) return '';
  let str = value instanceof Date ? value.toISOString() : String(value);
  if (str.length > 0 && FORMULA_TRIGGER_CHARS.has(str[0])) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const writeCsvRow = (values) => values.map(escapeCsvField).join(',') + '\r\n';

/**
 * `columns` is `[{ header, value: (row) => cellValue }, ...]`.
 * `fetchChunk(lastId, limit)` must return rows ordered by an `id` field
 * ascending, or `chunkSize` rows means keep going — the row shape only
 * needs an `id` property for cursoring, everything else comes from `columns`.
 */
// UTF-8 BOM (U+FEFF) — without it, Excel on Windows opens a UTF-8 CSV using
// the system's default ANSI codepage instead, rendering every non-ASCII
// character (all Uzbek/Russian text) as mojibake. LibreOffice/Sheets/Excel
// on other platforms all correctly treat a leading BOM as "this file is
// UTF-8" and skip it silently — safe to always send.
const UTF8_BOM = '﻿';

const streamRowsAsCsv = async (res, { filename, columns, fetchChunk, chunkSize = 1000 }) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.write(UTF8_BOM + writeCsvRow(columns.map((c) => c.header)));

  let lastId = 0;
  for (;;) {
    const rows = await fetchChunk(lastId, chunkSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      res.write(writeCsvRow(columns.map((c) => c.value(row))));
    }
    lastId = rows[rows.length - 1].id;
    if (rows.length < chunkSize) break;
  }
  res.end();
};

/** For the small, aggregate-bounded exports (reports summary, per-entity
 * statistics — inherently one row per installer/product/warehouse, not an
 * unbounded row-level table) where true chunking adds nothing: writes the
 * whole already-fetched array in one pass through the same CSV formatting,
 * so every export shares one response-header/escaping code path. */
const writeRowsAsCsv = (res, { filename, columns, rows }) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.write(UTF8_BOM + writeCsvRow(columns.map((c) => c.header)));
  for (const row of rows) {
    res.write(writeCsvRow(columns.map((c) => c.value(row))));
  }
  res.end();
};

module.exports = { escapeCsvField, writeCsvRow, streamRowsAsCsv, writeRowsAsCsv };
