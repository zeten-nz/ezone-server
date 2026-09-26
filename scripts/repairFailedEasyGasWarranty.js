require('dotenv').config();

// Operator-only: run from the backend directory so dotenv finds its .env.
// Importing this module performs no DB operations or HTTP requests.
const USAGE = 'Usage: node scripts/repairFailedEasyGasWarranty.js --id <warrantyId> (--dry-run | --apply | --retry)';
const LONG_NUMBER = /^(LPG|CNG)-(20\d{2})-(\d{6})$/;
const SHORT_NUMBER = /^(LPG|CNG)-\d{2}-\d{6}$/;

const parseArgs = (args) => {
  let id;
  let mode;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--id' && id === undefined) {
      const value = args[++i];
      if (!/^[1-9]\d*$/.test(value || '') || !Number.isSafeInteger(Number(value))) throw new Error(USAGE);
      id = Number(value);
    } else if (['--dry-run', '--apply', '--retry'].includes(args[i]) && !mode) {
      mode = args[i].slice(2);
    } else {
      throw new Error(USAGE);
    }
  }
  if (!id || !mode) throw new Error(USAGE);
  return { id, mode };
};

const inspect = (row) => {
  if (!row) throw new Error('warranty_not_found');
  const match = LONG_NUMBER.exec(row.warranty_book_number);
  const proposed = match ? `${match[1]}-${match[2].slice(-2)}-${match[3]}` : null;
  const reasons = [];
  if (row.status !== 'SUCCESSFUL') reasons.push('local_status_not_successful');
  if (row.easygas_sync_result !== 'FAILED') reasons.push('sync_not_failed');
  if (row.easygas_claim_url !== null) reasons.push('claim_url_not_null');
  return {
    id: row.id,
    warranty_book_number: row.warranty_book_number,
    fuel_type: row.fuel_type,
    status: row.status,
    easygas_sync_result: row.easygas_sync_result,
    claim_url_present: row.easygas_claim_url != null,
    error_eligible: String(row.easygas_sync_error || '').includes('FIELD_TOO_LONG'),
    proposed_warranty_book_number: proposed,
    reasons,
  };
};

const readForm = async (connection, id, lock = false) => {
  const [rows] = await connection.execute(
    `SELECT id, warranty_book_number, fuel_type, status, easygas_sync_result,
            easygas_claim_url, easygas_sync_error
     FROM warranty_forms WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id]
  );
  return rows[0];
};

const run = async ({ id, mode }, { pool, syncWarrantyForm, report = console.log }) => {
  if (!Number.isSafeInteger(id) || id <= 0 || !['dry-run', 'apply', 'retry'].includes(mode)) throw new Error(USAGE);
  const connection = await pool.getConnection();
  const lockName = `ezone:easygas-repair:${id}`;
  let locked = false;
  let transaction = false;
  try {
    // Serialize operator apply/retry invocations for this ID without holding
    // a row transaction across HTTP. Dry-run remains SELECT-only.
    if (mode !== 'dry-run') {
      const [rows] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
      if (rows[0]?.acquired !== 1) throw new Error('repair_already_running');
      locked = true;
    }
    if (mode === 'apply') {
      await connection.beginTransaction();
      transaction = true;
    }
    const row = await readForm(connection, id, transaction);
    const check = inspect(row);
    if (mode === 'retry') {
      if (!SHORT_NUMBER.test(row.warranty_book_number)) check.reasons.push('short_number_required');
      if (check.reasons.length) throw new Error(`retry_refused: ${check.reasons.join(',')}`);
      // The existing service reads the same stored form and submission_uuid.
      // No create, number allocation, or duplicate implementation here.
      await syncWarrantyForm(pool, id);
      const [rows] = await connection.execute(
        `SELECT easygas_sync_result, easygas_claim_url IS NOT NULL AS claim_url_present,
                easygas_sync_error FROM warranty_forms WHERE id = ?`, [id]
      );
      report(rows[0]);
      return rows[0];
    }
    if (!check.error_eligible) check.reasons.push('error_not_field_too_long');
    if (!check.proposed_warranty_book_number) check.reasons.push('long_fuel_number_required');
    if (check.proposed_warranty_book_number) {
      const [collisions] = await connection.execute(
        `SELECT id FROM warranty_forms WHERE warranty_book_number = ? AND id <> ?${transaction ? ' FOR UPDATE' : ''}`,
        [check.proposed_warranty_book_number, id]
      );
      if (collisions.length) check.reasons.push('number_collision');
    }
    check.eligible = check.reasons.length === 0;
    if (mode === 'dry-run') {
      report(check);
      return check;
    }
    if (!check.eligible) throw new Error(`repair_refused: ${check.reasons.join(',')}`);
    const [result] = await connection.execute(
      `UPDATE warranty_forms SET warranty_book_number = ?
       WHERE id = ? AND warranty_book_number = ? AND status = 'SUCCESSFUL'
         AND easygas_sync_result = 'FAILED' AND easygas_claim_url IS NULL
         AND easygas_sync_error = ?`,
      [check.proposed_warranty_book_number, id, row.warranty_book_number, row.easygas_sync_error]
    );
    if (result.affectedRows !== 1) throw new Error('repair_state_changed');
    const repaired = await readForm(connection, id);
    await connection.commit();
    transaction = false;
    const outcome = { id, warranty_book_number: repaired.warranty_book_number };
    report(outcome);
    return outcome;
  } catch (error) {
    if (transaction) await connection.rollback();
    throw error;
  } finally {
    try {
      if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
    } finally {
      connection.release();
    }
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  // dotenv above MUST run before either import (the service reads env too).
  const { pool } = require('../config/database');
  const { syncWarrantyForm } = require('../services/easyGasWarrantySyncService');
  try {
    const outcome = await run(options, { pool, syncWarrantyForm, report: (value) => console.log(JSON.stringify(value, null, 2)) });
    if (options.mode === 'retry' && outcome.easygas_sync_result !== 'SUCCESS') process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

if (require.main === module) {
  main().catch((error) => {
    // DB error messages can contain connection details. Print only our own
    // bounded operational errors, otherwise the driver error code.
    console.error(error.code || error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, inspect, run };
