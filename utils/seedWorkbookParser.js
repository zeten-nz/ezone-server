/**
 * Workbook parsing for the production employee seed — deliberately isolated
 * from employee-creation business logic (services/employeeSeedService.js):
 * this module only turns a spreadsheet into typed source rows and validates
 * per-cell shapes. It never touches the database and never mutates the
 * workbook.
 *
 * Source layout (authoritative, from the approved inspection):
 *   sheet "16,06,2026", header row 6 ("Т/р | Ташкилот номи | …"),
 *   A=branch code (NN/N), B=organization name, C=organization leader
 *   (→ employee full_name), D=address, E=leader phone, F=employee phone,
 *   G=service prefix (eg|st|bs, operator-filled, case-insensitive).
 * Region section headings ("… вилояти буйича") and banner/title rows carry
 * no NN/N code in column A and are skipped as non-branch rows.
 */

const BRANCH_CODE_RE = /^\d{2}\/\d{1,3}$/;
const SERVICE_PREFIXES = new Set(['eg', 'st', 'bs']);

// exceljs cell values can be string | number | Date | {richText} | {text} |
// {result} (formula) | null — collapse every shape to one trimmed string.
const cellText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('').trim();
    if (value.text !== undefined) return String(value.text).trim();
    if (value.result !== undefined) return String(value.result).trim();
    if (value instanceof Date) return value.toISOString();
    return String(value).trim();
  }
  return String(value).trim();
};

/** exceljs worksheet → plain [{ rowNumber, a..g }] — the only exceljs-aware step. */
const extractRawRows = (worksheet) => {
  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    rows.push({
      rowNumber,
      a: cellText(row.getCell(1).value),
      b: cellText(row.getCell(2).value),
      c: cellText(row.getCell(3).value),
      d: cellText(row.getCell(4).value),
      e: cellText(row.getCell(5).value),
      f: cellText(row.getCell(6).value),
      g: cellText(row.getCell(7).value),
    });
  });
  return rows;
};

/**
 * Pure classification of raw rows into branch rows vs skipped structure
 * (banners, the header row, region headings). A "ghost" row carries a
 * branch code but no name/organization/phones (the known 10/6 case) —
 * flagged here, classified INCOMPLETE_SOURCE_DATA by the planner.
 */
const parseSeedRows = (rawRows) => {
  let headerRowNumber = null;
  const branchRows = [];
  const skippedRows = [];
  for (const row of rawRows) {
    if (headerRowNumber === null && row.a === 'Т/р') {
      headerRowNumber = row.rowNumber;
      continue;
    }
    if (!BRANCH_CODE_RE.test(row.a)) {
      if (row.a || row.b) skippedRows.push({ rowNumber: row.rowNumber, label: (row.a || row.b).slice(0, 40) });
      continue;
    }
    branchRows.push({
      rowNumber: row.rowNumber,
      branchCode: row.a,
      orgName: row.b,
      fullName: row.c,
      address: row.d,
      leaderPhoneRaw: row.e,
      employeePhoneRaw: row.f,
      servicePrefixRaw: row.g,
      isGhost: !row.b && !row.c && !row.e && !row.f,
    });
  }
  return { headerRowNumber, branchRows, skippedRows };
};

/**
 * Column G — the explicit, human-reviewed, AUTHORITATIVE import
 * classification. Case-insensitive, whitespace-trimmed; never inferred
 * from the organization name or any heuristic.
 */
const parseServicePrefix = (raw) => {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { error: 'MISSING_SERVICE_PREFIX' };
  const canonical = trimmed.toLowerCase();
  if (!SERVICE_PREFIXES.has(canonical)) return { error: 'INVALID_SERVICE_PREFIX' };
  return { prefix: canonical };
};

/**
 * Employee phone (column F ONLY — column E is the leader's phone and is
 * never substituted) → canonical +998XXXXXXXXX, accepted only when the
 * source CONFIDENTLY reduces to the 9-digit national number: exactly 9
 * digits, or 12 digits starting with the 998 country code. Anything else
 * is INVALID_PHONE rather than a guess.
 */
const normalizeEmployeePhone = (raw) => {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return { error: 'MISSING_PHONE' };
  if (digits.length === 9) return { phone: `+998${digits}` };
  if (digits.length === 12 && digits.startsWith('998')) return { phone: `+998${digits.slice(3)}` };
  return { error: 'INVALID_PHONE' };
};

/** For console output — never print full phone numbers in routine logs. */
const maskPhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return phone ? '***' : '(none)';
  return `${digits.slice(0, 2)}*****${digits.slice(-2)}`;
};

module.exports = { BRANCH_CODE_RE, cellText, extractRawRows, parseSeedRows, parseServicePrefix, normalizeEmployeePhone, maskPhone };
