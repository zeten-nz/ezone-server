#!/usr/bin/env node
/**
 * Production employee seed CLI.
 *
 *   node scripts/seedProductionEmployees.js --file ".local-import/kafolat daftari 2026 (2).xlsx" --dry-run
 *   node scripts/seedProductionEmployees.js --file "/root/import/….xlsx" \
 *     --credentials-file "/root/secure/ezone-employee-credentials-YYYY-MM-DD.csv" --apply
 *
 * Modes (exactly one required — no mode means usage + exit, never apply):
 *   --dry-run           plan + report only. ZERO DB mutations (the planner
 *                       performs read-only SELECTs, and connects at all only
 *                       when a row survives source-level validation).
 *   --apply             create the READY accounts. REFUSED while any
 *                       error-class row exists, unless --allow-partial.
 * Options:
 *   --file <xlsx>              source workbook (required; read-only, never modified)
 *   --sheet <name>             worksheet name (default "16,06,2026")
 *   --credentials-file <path>  REQUIRED with --apply. Must be OUTSIDE the
 *                              repository; must not already exist (never
 *                              silently overwritten); chmod 600 attempted.
 *                              Receives credentials for NEWLY CREATED users
 *                              only — ALREADY_EXISTS accounts never get a
 *                              password reset or a regenerated credential.
 *   --allow-partial            apply the READY subset despite error rows
 *                              (prefer a fully clean dry-run instead).
 *
 * Passwords are generated with crypto, stored only as bcrypt hashes, and
 * never printed to the console. Phone numbers are masked in all output.
 */

const fs = require('fs');
const path = require('path');
const { extractRawRows, parseSeedRows, maskPhone } = require('../utils/seedWorkbookParser');
const { planSeed, applySeed, NON_BLOCKING_STATUSES } = require('../services/employeeSeedService');
const { escapeCsvField } = require('../utils/csvStream');

const REPO_ROOT = path.resolve(__dirname, '..');

const usage = (message) => {
  if (message) console.error(`ERROR: ${message}\n`);
  console.error(
    'Usage:\n' +
    '  node scripts/seedProductionEmployees.js --file <workbook.xlsx> --dry-run\n' +
    '  node scripts/seedProductionEmployees.js --file <workbook.xlsx> --credentials-file <path-outside-repo.csv> --apply [--allow-partial]\n'
  );
  process.exit(1);
};

const parseArgs = (argv) => {
  const args = { sheet: '16,06,2026', dryRun: false, apply: false, allowPartial: false, file: null, credentialsFile: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--allow-partial') args.allowPartial = true;
    else if (arg === '--file') args.file = argv[++i];
    else if (arg === '--sheet') args.sheet = argv[++i];
    else if (arg === '--credentials-file') args.credentialsFile = argv[++i];
    else usage(`unknown argument: ${arg}`);
  }
  return args;
};

/**
 * Exclusive-create credentials file: 'wx' fails if the file exists (no
 * silent overwrite), the resolved path must sit OUTSIDE the repository, and
 * permissions are tightened to 0600 (best-effort on Windows). Lines are
 * flushed (fsync) after every write so a committed account's password can
 * never be lost to a crash.
 */
const openCredentialsFile = (filePath, repoRoot = REPO_ROOT) => {
  const resolved = path.resolve(filePath);
  const rel = path.relative(repoRoot, resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`credentials file must be OUTSIDE the repository (${repoRoot}); got ${resolved}`);
  }
  const fd = fs.openSync(resolved, 'wx');
  try { fs.chmodSync(resolved, 0o600); } catch { /* best-effort on Windows */ }
  const header = ['branch_code', 'full_name', 'username', 'temporary_password', 'phone'];
  fs.writeSync(fd, '﻿' + header.join(',') + '\r\n');
  fs.fsyncSync(fd);
  return {
    path: resolved,
    writeLine: ({ branch_code, full_name, username, temporary_password, phone }) => {
      const line = [branch_code, full_name, username, temporary_password, phone].map(escapeCsvField).join(',') + '\r\n';
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    },
    close: () => fs.closeSync(fd),
  };
};

const STATUS_ORDER = [
  'READY', 'ALREADY_EXISTS', 'INCOMPLETE_SOURCE_DATA',
  'MISSING_SERVICE_PREFIX', 'INVALID_SERVICE_PREFIX', 'MISSING_LOCAL_BRANCH',
  'MISSING_NAME', 'INVALID_NAME', 'MISSING_PHONE', 'INVALID_PHONE',
  'USERNAME_COLLISION', 'BRANCH_TYPE_CONFLICT', 'APPLY_FAILED',
];

const printPlanReport = (plan, totalBranchRows) => {
  console.log(`\n=== SEED PLAN ===`);
  console.log(`workbook branch rows: ${totalBranchRows}`);
  for (const status of STATUS_ORDER) {
    if (plan.counts[status]) console.log(`  ${status}: ${plan.counts[status]}`);
  }
  console.log(`  warnings: ${plan.warningCount}`);
  console.log(`  database used for planning: ${plan.usedDb ? 'yes (read-only lookups)' : 'no (all rows resolved from source alone)'}`);

  const problems = plan.entries.filter((e) => e.status !== 'READY' && e.status !== 'ALREADY_EXISTS');
  if (problems.length) {
    console.log('\n--- non-ready rows ---');
    for (const e of problems) {
      console.log(`  xlsx row ${e.rowNumber} [${e.branchCode}] ${e.status}${e.username ? ` (${e.username})` : ''}: ${e.reason}`);
    }
  }
  const ready = plan.entries.filter((e) => e.status === 'READY');
  if (ready.length) {
    console.log('\n--- READY rows ---');
    for (const e of ready) {
      console.log(`  xlsx row ${e.rowNumber} [${e.branchCode}] ${e.username} phone=${maskPhone(e.phone)}`);
    }
  }
  const existing = plan.entries.filter((e) => e.status === 'ALREADY_EXISTS');
  if (existing.length) {
    console.log('\n--- ALREADY_EXISTS rows ---');
    for (const e of existing) {
      console.log(`  xlsx row ${e.rowNumber} [${e.branchCode}] ${e.username}: ${e.reason}`);
    }
  }
  const warned = plan.entries.filter((e) => e.warnings.length);
  if (warned.length) {
    console.log('\n--- warnings ---');
    for (const e of warned) {
      for (const w of e.warnings) console.log(`  xlsx row ${e.rowNumber} [${e.branchCode}] WARNING ${w.code}: ${w.detail}`);
    }
  }
};

const main = async () => {
  const args = parseArgs(process.argv);
  if (args.dryRun === args.apply) usage('exactly one of --dry-run or --apply is required');
  if (!args.file) usage('--file is required');
  if (args.apply && !args.credentialsFile) usage('--apply requires --credentials-file (path outside the repository)');
  if (!fs.existsSync(args.file)) usage(`workbook not found: ${args.file}`);

  // exceljs is an existing backend dependency — reused, nothing new added.
  const Excel = require('exceljs');
  const workbook = new Excel.Workbook();
  await workbook.xlsx.readFile(args.file); // read-only: the workbook is never written back
  const worksheet = workbook.getWorksheet(args.sheet);
  if (!worksheet) usage(`sheet "${args.sheet}" not found in ${args.file}`);

  const { headerRowNumber, branchRows } = parseSeedRows(extractRawRows(worksheet));
  if (headerRowNumber !== null && headerRowNumber !== 6) {
    console.log(`note: header row detected at ${headerRowNumber} (expected 6) — column mapping unchanged`);
  }

  // The DB is touched lazily and read-only during planning; connections are
  // only opened when at least one row passes source-level validation.
  let heldConnection = null;
  const getConnection = async () => {
    if (!heldConnection) {
      const { pool } = require('../config/database');
      heldConnection = await pool.getConnection();
    }
    return heldConnection;
  };

  try {
    const plan = await planSeed({ rows: branchRows, getConnection });
    printPlanReport(plan, branchRows.length);

    if (args.dryRun) {
      if (plan.blockers.length) {
        console.log(`\nDRY-RUN ONLY — apply WOULD BE REFUSED: ${plan.blockers.length} error-class row(s) (see above).`);
      } else {
        console.log('\nDRY-RUN ONLY — plan is clean; apply would create ' +
          `${plan.counts.READY || 0} account(s).`);
      }
      console.log('No database mutations were performed.');
      return;
    }

    // ── apply ──
    if (plan.blockers.length && !args.allowPartial) {
      console.error(`\nAPPLY REFUSED: ${plan.blockers.length} error-class row(s) unresolved. ` +
        'Fix the source (or pass --allow-partial to import only the READY subset — a fully clean dry-run is preferred).');
      process.exitCode = 1;
      return;
    }

    const credentials = openCredentialsFile(args.credentialsFile);
    try {
      const result = await applySeed({ plan, getConnection, credentialsWriter: credentials, log: (line) => console.log(line) });
      console.log(`\n=== APPLY RESULT ===`);
      console.log(`created: ${result.created.length}`);
      console.log(`skipped (non-READY, incl. ALREADY_EXISTS): ${result.skipped.length}`);
      console.log(`failed: ${result.failed.length}`);
      console.log(`credentials for the ${result.created.length} new account(s): ${credentials.path} (keep secure; not in the repo)`);
      if (result.failed.length) process.exitCode = 1;
    } finally {
      credentials.close();
    }
  } finally {
    if (heldConnection) heldConnection.release();
    // close the pool so the CLI process can exit promptly
    if (heldConnection) {
      try { require('../config/database').pool.end(); } catch { /* already closed */ }
    }
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`SEED FAILURE: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, openCredentialsFile, printPlanReport };
