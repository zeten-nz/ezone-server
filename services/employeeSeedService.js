/**
 * Production employee seed — planning + application (business logic only;
 * workbook parsing lives in utils/seedWorkbookParser.js, the CLI in
 * scripts/seedProductionEmployees.js).
 *
 * NON-NEGOTIABLE INVARIANTS (approved seed spec):
 * - Column G is the authoritative classification signal; nothing is inferred
 *   from organization names.
 * - Branches are NEVER created or renamed here — branches.code lookup only;
 *   a missing local branch fails that row (MISSING_LOCAL_BRANCH).
 * - Every created user goes through the EXISTING Beta-2
 *   managedEmployeeService.enforceForCreate inside one transaction with the
 *   INSERT — the importer never writes branches.branch_type directly.
 * - Duplicate phones across rows are a WARNING, never a merge: users.phone
 *   is not unique, and separate branches get separate accounts even for the
 *   same human (one branch_id per EMPLOYEE — warranty creation must
 *   snapshot the correct installer branch).
 * - Idempotent: an existing username that clearly IS the intended account
 *   (EMPLOYEE on the same branch) is ALREADY_EXISTS — no insert, no
 *   password reset, no credential regeneration. A username held by any
 *   other identity/branch is USERNAME_COLLISION — never auto-suffixed.
 * - Ghost rows (branch code only — the known 10/6) are
 *   INCOMPLETE_SOURCE_DATA: skipped, never backfilled with fake data.
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const managedEmployeeService = require('./managedEmployeeService');
const { parseManagedEmployeeUsername } = require('../utils/managedUsername');
const { extractGivenNameSlug } = require('../utils/uzbekTranslit');
const { parseServicePrefix, normalizeEmployeePhone } = require('../utils/seedWorkbookParser');
const { normalizePhone } = require('../utils/phoneFormat');
const { USERNAME_PREFIX_TO_BRANCH_TYPE } = require('../config/branchTypes');

// Statuses that do NOT block a full --apply. INCOMPLETE_SOURCE_DATA is the
// explicitly recognized intentional skip (10/6); everything else outside
// this set is error-class and blocks apply unless --allow-partial.
const NON_BLOCKING_STATUSES = new Set(['READY', 'ALREADY_EXISTS', 'INCOMPLETE_SOURCE_DATA']);

/**
 * <prefix>_<given-name-slug>_<region>_<branchNumber> from the approved
 * rules. The result must round-trip through the canonical Beta-2 parser
 * and reconstruct exactly the source branch code — asserted here so a
 * malformed slug can never silently produce a legacy-shaped username.
 */
const buildSeedUsername = ({ prefix, fullName, branchCode }) => {
  if (!String(fullName || '').trim()) return { error: 'MISSING_NAME' };
  const slug = extractGivenNameSlug(fullName);
  if (!slug) return { error: 'INVALID_NAME' };
  const [region, branchNumber] = branchCode.split('/');
  const username = `${prefix}_${slug}_${region}_${branchNumber}`;
  const parsed = parseManagedEmployeeUsername(username);
  if (!parsed.managed || parsed.branchCode !== branchCode) return { error: 'INVALID_NAME' };
  return { username };
};

// Loose informational comparison ONLY (ORGANIZATION_NAME_DIFFERENCE is a
// warning, local branch names stay authoritative and are never overwritten).
const normalizeOrgName = (name) => String(name || '').toLowerCase().replace(/[^a-zа-яёқғҳўa-z0-9]/giu, '');

/**
 * Plans the seed. READ-ONLY: performs only SELECTs, and connects lazily —
 * rows that fail source-level validation (prefix/name/phone/ghost) never
 * need the database at all, so a workbook whose G column is still blank
 * dry-runs with zero DB access.
 *
 * `rows` = parseSeedRows(...).branchRows; `getConnection` → mysql2-style
 * connection (caller releases it; `plan` never begins a transaction).
 */
const planSeed = async ({ rows, getConnection }) => {
  let connection = null;
  const lazyConnection = async () => {
    if (!connection) connection = await getConnection();
    return connection;
  };

  const entries = [];
  for (const row of rows) {
    const entry = {
      rowNumber: row.rowNumber,
      branchCode: row.branchCode,
      fullName: row.fullName,
      orgName: row.orgName,
      status: null,
      reason: null,
      warnings: [],
      username: null,
      phone: null,
      branchId: null,
    };
    entries.push(entry);

    if (row.isGhost) {
      entry.status = 'INCOMPLETE_SOURCE_DATA';
      entry.reason = 'source row is empty except for the branch code — intentionally skipped, nothing fabricated';
      continue;
    }

    const prefixResult = parseServicePrefix(row.servicePrefixRaw);
    if (prefixResult.error) {
      entry.status = prefixResult.error;
      entry.reason = prefixResult.error === 'MISSING_SERVICE_PREFIX'
        ? 'column G is blank — operator must fill eg/st/bs before import'
        : `column G value ${JSON.stringify(String(row.servicePrefixRaw).trim())} is not eg/st/bs`;
      continue;
    }

    const usernameResult = buildSeedUsername({ prefix: prefixResult.prefix, fullName: row.fullName, branchCode: row.branchCode });
    if (usernameResult.error) {
      entry.status = usernameResult.error;
      entry.reason = usernameResult.error === 'MISSING_NAME'
        ? 'column C (organization leader) is empty'
        : 'no usable given-name token could be extracted from column C';
      continue;
    }
    entry.username = usernameResult.username;

    const phoneResult = normalizeEmployeePhone(row.employeePhoneRaw);
    if (phoneResult.error) {
      entry.status = phoneResult.error;
      entry.reason = phoneResult.error === 'MISSING_PHONE'
        ? 'column F (employee phone) is empty'
        : 'column F does not confidently reduce to a 9-digit UZ number';
      continue;
    }
    entry.phone = phoneResult.phone;

    // ── from here the plan needs the database (read-only lookups) ──
    const conn = await lazyConnection();

    const [branchRows] = await conn.execute(
      'SELECT id, code, name, branch_type FROM branches WHERE code = ?',
      [row.branchCode]
    );
    const branch = branchRows[0];
    if (!branch) {
      entry.status = 'MISSING_LOCAL_BRANCH';
      entry.reason = `no local branch with code ${row.branchCode} — branches are never created from Excel`;
      continue;
    }
    entry.branchId = branch.id;

    if (branch.name && row.orgName && normalizeOrgName(branch.name) !== normalizeOrgName(row.orgName)) {
      entry.warnings.push({ code: 'ORGANIZATION_NAME_DIFFERENCE', detail: `local "${branch.name}" vs workbook "${row.orgName}" (informational — local name stays authoritative)` });
    }

    const expectedType = USERNAME_PREFIX_TO_BRANCH_TYPE[prefixResult.prefix];
    if (branch.branch_type !== null && branch.branch_type !== undefined && branch.branch_type !== expectedType) {
      entry.status = 'BRANCH_TYPE_CONFLICT';
      entry.reason = `branch ${branch.code} is already classified ${branch.branch_type}; G prefix "${prefixResult.prefix}" implies ${expectedType}`;
      continue;
    }

    const [userRows] = await conn.execute(
      'SELECT id, username, role, branch_id, phone, full_name FROM users WHERE username = ?',
      [entry.username]
    );
    const existing = userRows[0];
    if (existing) {
      if (existing.role === 'EMPLOYEE' && Number(existing.branch_id) === Number(branch.id)) {
        entry.status = 'ALREADY_EXISTS';
        const diffs = [];
        if (normalizePhone(existing.phone) !== normalizePhone(entry.phone)) diffs.push('phone differs');
        if (String(existing.full_name || '').trim() !== String(row.fullName).trim()) diffs.push('full_name differs');
        entry.reason = `account already exists on this branch — no insert, no password reset${diffs.length ? ` (${diffs.join(', ')})` : ''}`;
        continue;
      }
      entry.status = 'USERNAME_COLLISION';
      entry.reason = `username ${entry.username} already belongs to a different identity/branch (role ${existing.role}, branch_id ${existing.branch_id ?? 'none'}) — never auto-suffixed`;
      continue;
    }

    entry.status = 'READY';
  }

  // DUPLICATE_PHONE — WARNING only, across all rows that yielded a
  // normalized phone: separate branches keep separate accounts.
  const byPhone = new Map();
  for (const entry of entries) {
    if (!entry.phone) continue;
    if (!byPhone.has(entry.phone)) byPhone.set(entry.phone, []);
    byPhone.get(entry.phone).push(entry);
  }
  for (const group of byPhone.values()) {
    if (group.length < 2) continue;
    for (const entry of group) {
      entry.warnings.push({
        code: 'DUPLICATE_PHONE',
        detail: `same normalized phone as ${group.filter((o) => o !== entry).map((o) => `${o.branchCode} (xlsx row ${o.rowNumber})`).join(', ')} — allowed, accounts stay separate`,
      });
    }
  }

  const counts = {};
  for (const entry of entries) counts[entry.status] = (counts[entry.status] || 0) + 1;
  const blockers = entries.filter((e) => !NON_BLOCKING_STATUSES.has(e.status));
  const warningCount = entries.reduce((n, e) => n + e.warnings.length, 0);
  return { entries, counts, blockers, warningCount, usedDb: connection !== null };
};

// 16 chars from an unambiguous alphabet via crypto.randomInt — uniform,
// no modulo bias, comfortably above the 14-char minimum.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const generateTemporaryPassword = (length = 16) =>
  Array.from({ length }, () => PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)]).join('');

/**
 * Applies a plan: creates ONLY the READY entries, each as one transaction —
 * enforceForCreate (branch FOR UPDATE lock + classification) + user INSERT
 * commit or roll back together, exactly like the admin create endpoint.
 *
 * `credentialsWriter.writeLine({...})` receives each NEW account's
 * plaintext temporary password EXACTLY ONCE, immediately after that row's
 * commit (so a crash can never leave committed accounts with unrecorded
 * passwords beyond the row in flight). Passwords are never logged and only
 * the bcrypt hash is stored.
 *
 * A per-row failure rolls back that row only and is reported; remaining
 * rows continue (they are independent accounts).
 */
const applySeed = async ({ plan, getConnection, credentialsWriter, log = () => {} }) => {
  const created = [];
  const skipped = [];
  const failed = [];
  const connection = await getConnection();

  for (const entry of plan.entries) {
    if (entry.status !== 'READY') {
      skipped.push(entry);
      continue;
    }

    const temporaryPassword = generateTemporaryPassword();
    // hash BEFORE the transaction — never hold the branch row lock through CPU work
    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

    await connection.beginTransaction();
    try {
      // re-check inside the transaction — the plan may be minutes old
      const [existsRows] = await connection.execute('SELECT id FROM users WHERE username = ?', [entry.username]);
      if (existsRows.length > 0) {
        await connection.rollback();
        entry.status = 'ALREADY_EXISTS';
        entry.reason = 'account appeared between plan and apply — no insert, no password reset';
        skipped.push(entry);
        continue;
      }

      const { classification } = await managedEmployeeService.enforceForCreate(connection, {
        role: 'EMPLOYEE',
        username: entry.username,
        branchId: entry.branchId,
      });

      await connection.execute(
        'INSERT INTO users (full_name, username, password, phone, branch_id, role, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [entry.fullName, entry.username, hashedPassword, entry.phone, entry.branchId, 'EMPLOYEE', true]
      );

      await connection.commit();
      if (classification) {
        log(`[Seed] branch ${classification.branchCode}: NULL -> ${classification.newType} (established by seeding ${entry.username})`);
      }
      credentialsWriter.writeLine({
        branch_code: entry.branchCode,
        full_name: entry.fullName,
        username: entry.username,
        temporary_password: temporaryPassword,
        phone: entry.phone,
      });
      created.push(entry);
      log(`[Seed] created ${entry.username} (branch ${entry.branchCode})`);
    } catch (error) {
      await connection.rollback();
      entry.status = 'APPLY_FAILED';
      entry.reason = `${error.errorCode || error.code || 'ERROR'}: ${error.message}`;
      failed.push(entry);
      log(`[Seed] FAILED ${entry.username} (branch ${entry.branchCode}): ${entry.reason}`);
    }
  }

  return { created, skipped, failed };
};

module.exports = { planSeed, applySeed, buildSeedUsername, generateTemporaryPassword, NON_BLOCKING_STATUSES };
