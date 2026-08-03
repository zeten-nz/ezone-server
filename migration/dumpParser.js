/**
 * Read-only parser for the legacy STAG/EasyGas phpMyAdmin dump files
 * (stag-db/*.sql). This module NEVER executes any SQL against a database —
 * it only reads a .sql file's text and extracts the literal row values out
 * of its `INSERT INTO` statements as plain JS values (string | number | null).
 *
 * CREATE TABLE / ALTER TABLE / DROP TABLE statements in these files are
 * never located or interpreted by this parser at all — it only searches for
 * the `INSERT INTO \`table\` (\`col\`, ...) VALUES (...), (...);` pattern.
 * Nothing here is passed to mysql2 — the migrators turn the parsed values
 * into brand-new, parameterized INSERT statements against EZONE's own schema.
 */

const fs = require('fs');

/** Converts one raw field into a JS value. Quoted fields are returned verbatim (already unescaped); unquoted fields become null/number/left-as-string. */
function finalizeField(raw, wasQuoted) {
  if (wasQuoted) return raw;
  const trimmed = raw.trim();
  if (trimmed === 'NULL') return null;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  return trimmed;
}

const ESCAPE_MAP = { "'": "'", '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t', '0': '\0' };

/**
 * Scans `sql` starting right after a `VALUES` keyword and returns every
 * tuple's fields as an array of arrays, handling:
 *   - quoted strings containing commas/parens (addresses, product names)
 *   - backslash escapes (\', \\, \n, \r, \t)
 *   - whitespace between a comma and the next field's opening quote
 * Stops at the statement's closing top-level `;`.
 */
function parseValuesBlock(sql, startPos) {
  const rows = [];
  const n = sql.length;
  let i = startPos;

  while (i < n) {
    while (i < n && /\s/.test(sql[i])) i++;
    if (sql[i] === ';') { i++; break; }
    if (sql[i] === ',') { i++; continue; }
    if (sql[i] !== '(') {
      throw new Error(`Malformed dump: expected '(' at position ${i}, found '${sql[i]}'`);
    }
    i++; // consume '('

    const fields = [];
    let field = '';
    let inString = false;
    let wasQuoted = false;

    while (i < n) {
      const c = sql[i];

      if (inString) {
        if (c === '\\') {
          const next = sql[i + 1];
          field += ESCAPE_MAP[next] !== undefined ? ESCAPE_MAP[next] : next;
          i += 2;
          continue;
        }
        if (c === "'") { inString = false; i++; continue; }
        field += c;
        i++;
        continue;
      }

      // Whitespace sitting between a comma/`(` and the next field's first
      // real character (e.g. "(1, 'STAG'" has a space right before the
      // quote) must never be folded into the field's own content — a
      // quoted field is returned verbatim by finalizeField, so a leading
      // space here would otherwise corrupt every string value.
      if (field === '' && !wasQuoted && /\s/.test(c)) { i++; continue; }

      if (c === "'") { inString = true; wasQuoted = true; i++; continue; }
      if (c === ',') { fields.push(finalizeField(field, wasQuoted)); field = ''; wasQuoted = false; i++; continue; }
      if (c === ')') { fields.push(finalizeField(field, wasQuoted)); i++; break; }

      field += c;
      i++;
    }

    rows.push(fields);
  }

  return { rows, endPos: i };
}

/**
 * Parses every `INSERT INTO` statement in a dump file into a flat array of
 * `{ table, record }` objects, where `record` is a plain object keyed by
 * the dump's own column names.
 */
function parseDumpFile(filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  const insertHeaderRegex = /INSERT INTO `(\w+)`\s*\(([^)]+)\)\s*VALUES\s*/g;
  const statements = [];
  let match;

  while ((match = insertHeaderRegex.exec(sql))) {
    const table = match[1];
    const columns = match[2].split(',').map((c) => c.trim().replace(/`/g, ''));
    const { rows, endPos } = parseValuesBlock(sql, insertHeaderRegex.lastIndex);

    for (const values of rows) {
      const record = {};
      columns.forEach((col, idx) => { record[col] = values[idx]; });
      statements.push({ table, record });
    }

    insertHeaderRegex.lastIndex = endPos;
  }

  return statements;
}

module.exports = { parseDumpFile };
