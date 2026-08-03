/**
 * All raw SQL for warranty_forms. Every method takes the caller's `connection`
 * and never acquires its own — warrantyService owns the transaction boundary
 * (beginTransaction/commit/rollback), never a repository.
 */

// A warranty has exactly one fuel type for the whole installation
// (warranty_forms.fuel_type). The LEFT JOIN + COALESCE resolves it for
// historical rows predating that column too — same fallback chain as
// config/database.js's one-time backfillWarrantyFuelType migration, kept
// here as a defensive read-time resolution (not a replacement for it) in
// case any row is ever read before a boot's backfill has run. Listed AFTER
// `wf.*` in every SELECT below so it overwrites the raw column with the
// resolved value in the resulting row object.
const FUEL_TYPE_JOIN = `LEFT JOIN warranty_equipment we_ft ON we_ft.warranty_form_id = wf.id AND we_ft.equipment_type = 'REDUCER'`;
const FUEL_TYPE_SELECT = `COALESCE(wf.fuel_type, we_ft.fuel_type, wf.reducer_fuel_type) AS fuel_type`;

/**
 * Installer info is never re-typed on the form — it's a snapshot of the
 * submitting employee's own profile + branch at submission time (region/
 * district/branch name/code are the employee's branch; phone/full_name are
 * the employee's own). Returns null if the employee has no branch assigned
 * or that branch is missing required fields — callers must treat that as
 * blocking (see AppError 'INCOMPLETE_PROFILE' in warrantyService).
 */
const getEmployeeSnapshot = async (connection, employeeId) => {
  const [rows] = await connection.execute(
    `SELECT u.full_name, u.phone AS installer_phone,
            b.region, b.district, b.city, b.name AS branch_name, b.code AS branch_code, b.phone AS branch_phone
     FROM users u LEFT JOIN branches b ON u.branch_id = b.id
     WHERE u.id = ?`,
    [employeeId]
  );
  const employee = rows[0];
  if (!employee || !employee.region || !employee.district || !employee.branch_name || !employee.branch_code) {
    return null;
  }
  return employee;
};

/**
 * Local, sequential, per-year warranty numbering (W-2026-000001, ...) —
 * EZONE's own, with no external dependency. Atomic under concurrent
 * submissions via the documented MySQL idiom for emulating a sequence on a
 * non-AUTO_INCREMENT column: `LAST_INSERT_ID(expr)` in BOTH the INSERT's
 * VALUES and the ON DUPLICATE KEY UPDATE clause sets the session's
 * last-insert-id to `expr` either way, so `result.insertId` is correct
 * whether this is the first warranty of the year (fresh row) or the Nth
 * (existing row incremented) — using only the VALUES-clause literal would
 * leave insertId wrong (stale/0) on that first-of-the-year branch.
 */
const getNextWarrantyNumber = async (connection, year) => {
  const [result] = await connection.execute(
    `INSERT INTO warranty_number_sequences (year, last_number) VALUES (?, LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE last_number = LAST_INSERT_ID(last_number + 1)`,
    [year]
  );
  return `W-${year}-${String(result.insertId).padStart(6, '0')}`;
};

const insert = async (connection, employeeId, snapshot, data, warrantyBookNumber) => {
  const [result] = await connection.execute(
    `INSERT INTO warranty_forms (
       employee_id, installer_region, city, installer_district, installer_branch, organization_phone,
       installer_full_name, installer_phone, installer_branch_code,
       submission_uuid, warranty_book_number, installation_date, fuel_type,
       vehicle_name, car_id, vehicle_production_year, vehicle_plate_number, vehicle_vin, vehicle_mileage,
       owner_full_name, owner_phone
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      employeeId, snapshot.region, snapshot.city || null, snapshot.district, snapshot.branch_name, snapshot.branch_phone || null,
      snapshot.full_name, snapshot.installer_phone || null, snapshot.branch_code,
      data.submission_uuid, warrantyBookNumber, data.installation_date, data.fuel_type,
      data.vehicle_name, data.car_id || null, data.vehicle_production_year, data.vehicle_plate_number || null, data.vehicle_vin, data.vehicle_mileage,
      data.owner_full_name, data.owner_phone,
    ]
  );
  return result.insertId;
};

// region/district/installer_branch/installer_full_name/installer_phone/
// installer_branch_code are deliberately absent here — they're a one-time
// snapshot taken at creation (see getEmployeeSnapshot), never re-derived or
// overwritten by an edit even if the employee's branch changes later.
// submission_uuid is ALSO deliberately absent — it's this warranty's
// create-idempotency key (protects against a client retrying a POST it
// doesn't know already succeeded), set once at creation and immutable
// afterward, same treatment as the snapshot fields above.
// warranty_book_number is deliberately absent too: it's assigned once, at
// creation, by warrantyRepository.getNextWarrantyNumber — an edit must never
// reassign or overwrite it.
const update = async (connection, formId, data) => {
  await connection.execute(
    `UPDATE warranty_forms SET
       installation_date = ?, fuel_type = ?,
       vehicle_name = ?, car_id = ?, vehicle_production_year = ?, vehicle_plate_number = ?, vehicle_vin = ?, vehicle_mileage = ?,
       owner_full_name = ?, owner_phone = ?
     WHERE id = ?`,
    [
      data.installation_date, data.fuel_type,
      data.vehicle_name, data.car_id || null, data.vehicle_production_year, data.vehicle_plate_number || null, data.vehicle_vin, data.vehicle_mileage,
      data.owner_full_name, data.owner_phone,
      formId,
    ]
  );
};

const findOwnershipInfo = async (connection, formId) => {
  const [rows] = await connection.execute('SELECT id, employee_id, created_at FROM warranty_forms WHERE id = ?', [formId]);
  return rows[0] || null;
};

const findBySubmissionUuid = async (connection, submissionUuid) => {
  const [rows] = await connection.execute('SELECT id FROM warranty_forms WHERE submission_uuid = ?', [submissionUuid]);
  return rows[0]?.id || null;
};

/**
 * Acquires a row lock on this warranty for the duration of the caller's
 * transaction, serializing concurrent update/delete operations on the SAME
 * warranty (a different problem from the atomic inventory-item claim in
 * inventoryRepository — this guards the warranty row itself, not a barcode).
 * Must be called AFTER connection.beginTransaction() to actually hold the
 * lock; returns null (not a thrown error — that's the service layer's job,
 * matching this file's existing convention) if the warranty no longer
 * exists, which can happen if a concurrent request deleted it between the
 * caller's earlier pre-transaction ownership check and this lock attempt.
 */
const lockForm = async (connection, formId) => {
  const [rows] = await connection.execute('SELECT id FROM warranty_forms WHERE id = ? FOR UPDATE', [formId]);
  return rows[0] || null;
};

// `employeeId` scopes the admin list to one installer's warranties (e.g. an
// "open installer" drill-down from statistics) — optional, combined with
// `search`/pagination exactly like every other admin list filter, not a
// separate endpoint or table. `verificationStatus` is the Manual Verification
// workflow's admin filter (e.g. "show me every warranty with a row still
// PENDING review") — an EXISTS against warranty_equipment, since the status
// itself lives per equipment row, not on this table (see the migration's
// reasoning in config/database.js).
const findAllPaginated = async (connection, { limit, offset, search, employeeId, verificationStatus }) => {
  const conditions = [];
  const filterParams = [];
  if (employeeId) {
    conditions.push('wf.employee_id = ?');
    filterParams.push(employeeId);
  }
  if (verificationStatus) {
    conditions.push(`EXISTS (
      SELECT 1 FROM warranty_equipment we
      WHERE we.warranty_form_id = wf.id AND we.verification_status = ?
    )`);
    filterParams.push(verificationStatus);
  }
  if (search) {
    conditions.push('(wf.vehicle_plate_number LIKE ? OR wf.owner_full_name LIKE ? OR u.full_name LIKE ?)');
    filterParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const [countRows] = await connection.execute(
    `SELECT COUNT(*) AS total FROM warranty_forms wf JOIN users u ON wf.employee_id = u.id ${whereClause}`,
    filterParams
  );
  const [rows] = await connection.execute(
    `SELECT wf.*, u.full_name AS employee_name, u.username AS employee_username, ${FUEL_TYPE_SELECT}
     FROM warranty_forms wf JOIN users u ON wf.employee_id = u.id
     ${FUEL_TYPE_JOIN}
     ${whereClause} ORDER BY wf.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    filterParams
  );
  return { rows, total: countRows[0].total };
};

const findMinePaginated = async (connection, employeeId, { limit, offset, search }) => {
  let whereClause = 'WHERE wf.employee_id = ?';
  const filterParams = [employeeId];
  if (search) {
    whereClause += ' AND (wf.vehicle_plate_number LIKE ? OR wf.owner_full_name LIKE ?)';
    filterParams.push(`%${search}%`, `%${search}%`);
  }
  const [countRows] = await connection.execute(`SELECT COUNT(*) AS total FROM warranty_forms wf ${whereClause}`, filterParams);
  const [rows] = await connection.execute(
    `SELECT wf.*, ${FUEL_TYPE_SELECT} FROM warranty_forms wf ${FUEL_TYPE_JOIN}
     ${whereClause} ORDER BY wf.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    filterParams
  );
  return { rows, total: countRows[0].total };
};

const findDetailById = async (connection, formId) => {
  const [rows] = await connection.execute(
    `SELECT wf.*, u.full_name AS employee_name, u.username AS employee_username, ${FUEL_TYPE_SELECT}
     FROM warranty_forms wf JOIN users u ON wf.employee_id = u.id
     ${FUEL_TYPE_JOIN}
     WHERE wf.id = ?`,
    [formId]
  );
  return rows[0] || null;
};

const searchForms = async (connection, { search, filterType }) => {
  let query = `SELECT wf.*, u.full_name AS employee_name, u.username AS employee_username, ${FUEL_TYPE_SELECT}
               FROM warranty_forms wf JOIN users u ON wf.employee_id = u.id
               ${FUEL_TYPE_JOIN}
               WHERE 1=1`;
  const params = [];

  if (search) {
    if (filterType === 'vehicle_plate') {
      query += ' AND wf.vehicle_plate_number LIKE ?';
      params.push(`%${search}%`);
    } else if (filterType === 'owner_name') {
      query += ' AND wf.owner_full_name LIKE ?';
      params.push(`%${search}%`);
    } else if (filterType === 'employee_name') {
      query += ' AND u.full_name LIKE ?';
      params.push(`%${search}%`);
    } else {
      query += ' AND (wf.vehicle_plate_number LIKE ? OR wf.owner_full_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
  }

  query += ' ORDER BY wf.created_at DESC';

  const [rows] = await connection.execute(query, params);
  return rows;
};

/**
 * Public customer lookup — every warranty registered to a given owner phone
 * number, newest first. No pagination (matches the original endpoint's
 * scope: a customer's own warranty list is never large enough to need it).
 * Same SELECT/JOIN shape as searchForms above, filtered on owner_phone
 * instead of a free-text search term.
 *
 * `normalizedPhone` must already be the 9-digit national significant number
 * (see utils/phoneFormat.js's normalizePhone) — never the raw client input.
 * Existing owner_phone rows are NOT stored under one consistent shape
 * (confirmed directly against production: some are a bare 9-digit number
 * with no country code, unlike the '+998XXXXXXXXX' shape newer rows use) —
 * rather than assume one, this reduces owner_phone to the same 9-digit key
 * at query time via REGEXP_REPLACE (strip everything but digits) + RIGHT
 * (take the last 9), so both sides of the comparison are on equal footing
 * regardless of which format a given row happens to store. Stored data is
 * never rewritten — this normalization exists only inside the WHERE clause.
 *
 * Trade-off, accepted deliberately: REGEXP_REPLACE/RIGHT on owner_phone
 * makes this comparison non-sargable (no index on owner_phone can be used,
 * so this is a full table scan) — acceptable at this table's current size;
 * revisit with a generated/indexed column if warranty_forms grows enough
 * for it to matter.
 */
const findByOwnerPhone = async (connection, normalizedPhone) => {
  const [rows] = await connection.execute(
    `SELECT wf.*, u.full_name AS employee_name, u.username AS employee_username, ${FUEL_TYPE_SELECT}
     FROM warranty_forms wf JOIN users u ON wf.employee_id = u.id
     ${FUEL_TYPE_JOIN}
     WHERE RIGHT(REGEXP_REPLACE(wf.owner_phone, '[^0-9]', ''), 9) = ?
     ORDER BY wf.created_at DESC`,
    [normalizedPhone]
  );
  return rows;
};

const deleteById = async (connection, formId) => {
  // warranty_equipment rows for this form are cleaned up automatically via
  // ON DELETE CASCADE — no manual unlink step needed (unlike the old
  // serialized-inventory model, products are never "released back to
  // stock" since they're a reusable catalog now, not consumed per-install).
  await connection.execute('DELETE FROM warranty_forms WHERE id = ?', [formId]);
};

/**
 * Keyset-paginated chunk for CSV export (Phase 4) — deliberately NOT the
 * same OFFSET-based pattern as findAllPaginated (used for ordinary UI
 * pagination). OFFSET shifts under concurrent writes (rows inserted mid-
 * export skip/duplicate across chunk boundaries); `WHERE id > ?` doesn't,
 * since new rows always get a higher id and never appear before the cursor
 * (see the Phase 4 plan's D6). Ordered by id, not created_at, for the same
 * reason — a stable, monotonic cursor.
 */
const findChunkForExport = async (connection, { lastId, limit, employeeId, search, verificationStatus }) => {
  const conditions = ['wf.id > ?'];
  const params = [lastId];
  if (employeeId) {
    conditions.push('wf.employee_id = ?');
    params.push(employeeId);
  }
  // Same filter conditions as findAllPaginated, kept in exact sync so
  // "export filtered results" always exports what the list is actually
  // showing — see findAllPaginated above for why each is shaped this way.
  if (verificationStatus) {
    conditions.push(`EXISTS (
      SELECT 1 FROM warranty_equipment we
      WHERE we.warranty_form_id = wf.id AND we.verification_status = ?
    )`);
    params.push(verificationStatus);
  }
  if (search) {
    conditions.push('(wf.vehicle_plate_number LIKE ? OR wf.owner_full_name LIKE ? OR u.full_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const [rows] = await connection.execute(
    `SELECT wf.*, u.full_name AS employee_name, u.username AS employee_username, ${FUEL_TYPE_SELECT}
     FROM warranty_forms wf JOIN users u ON wf.employee_id = u.id
     ${FUEL_TYPE_JOIN}
     WHERE ${conditions.join(' AND ')}
     ORDER BY wf.id ASC LIMIT ${Number(limit)}`,
    params
  );
  return rows;
};

module.exports = {
  getEmployeeSnapshot,
  getNextWarrantyNumber,
  insert,
  update,
  findOwnershipInfo,
  findBySubmissionUuid,
  lockForm,
  findAllPaginated,
  findMinePaginated,
  findDetailById,
  searchForms,
  findByOwnerPhone,
  deleteById,
  findChunkForExport,
};
