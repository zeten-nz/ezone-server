const AppError = require('../utils/AppError');
const { parseManagedEmployeeUsername } = require('../utils/managedUsername');
const { BRANCH_TYPES } = require('../config/branchTypes');

/**
 * Structured classification audit line — the ONE logger both onboarding
 * paths (admin direct-create and registration approval) share. No generic
 * persistent audit table exists in this codebase (the only audit stores are
 * inventory- and points-specific), so this follows the app's operational-log
 * convention. Never logs passwords or secrets.
 */
const logBranchClassification = ({ classification, actorId, employeeUsername, employeeId }) => {
  if (!classification) return;
  console.log(
    `[Branch Classification] branch ${classification.branchCode} (id ${classification.branchId}): ` +
    `NULL -> ${classification.newType} — established by admin #${actorId} onboarding employee ` +
    `${employeeUsername}${employeeId ? ` (#${employeeId})` : ''}`
  );
};

/**
 * Managed-employee username enforcement + authoritative branch
 * classification (Beta-2).
 *
 * BUSINESS MODEL: EMPLOYEE usernames follow
 * <prefix>_<human>_<region>_<branchNumber> (eg/st/bs → EASYGAS/
 * STAG_SERVICE/OTHER_SERVICE). The username convention is the authoritative
 * ONBOARDING signal only — runtime business logic reads the durable
 * branches.branch_type column this service establishes, never re-parses
 * usernames. Classification is NEVER inferred from branch names/codes/
 * history and NEVER sourced from EasyGas's /branches endpoint.
 *
 * CALLING CONTRACT: both functions MUST run inside the caller's already-open
 * transaction (userController.createUser/updateUser) — the branch row is
 * read FOR UPDATE, so "validate + classify branch + write user" commits or
 * rolls back as ONE business operation: a user can never exist without its
 * classification having succeeded, and a classification can never survive a
 * rolled-back user write.
 *
 * CONCURRENCY: two admins concurrently onboarding conflicting prefixes
 * (eg_… vs st_…) against the same still-NULL branch serialize on the FOR
 * UPDATE row lock — the second transaction re-reads the winner's committed
 * type and fails with BRANCH_TYPE_CONFLICT. As belt-and-braces against any
 * lockless caller, the classification write itself is an atomic conditional
 * UPDATE (`WHERE branch_type IS NULL`); if it matches 0 rows the service
 * re-reads and either accepts an identical concurrent classification or
 * throws BRANCH_TYPE_CONFLICT. Last-write-wins is impossible: an
 * established branch_type is NEVER overwritten here (§11), and nothing in
 * this service ever sets branch_type back to NULL (§12 — no automatic
 * declassification on user delete/disable/unassign).
 */

/**
 * Validates the username against the SELECTED local branch and establishes
 * branch_type when the branch is still unclassified. Returns
 * `{ parsed, classification }` where classification is
 * `{ branchId, branchCode, oldType: null, newType }` when this call
 * established the type, else null.
 */
const classifyBranchForManagedEmployee = async (connection, { parsed, branchId }) => {
  const [rows] = await connection.execute(
    'SELECT id, code, branch_type FROM branches WHERE id = ? FOR UPDATE',
    [branchId]
  );
  const branch = rows[0];
  if (!branch) {
    throw new AppError('Selected branch does not exist', 404, 'BRANCH_NOT_FOUND');
  }

  // The username's reconstructed code must equal the selected branch's code
  // — never silently move the user, rewrite the username, or pick another
  // branch (§6).
  if (parsed.branchCode !== branch.code) {
    throw new AppError(
      `Username branch code ${parsed.branchCode} does not match the selected branch ${branch.code}`,
      400,
      'USERNAME_BRANCH_MISMATCH'
    );
  }

  if (branch.branch_type === parsed.branchType) {
    return null; // already classified identically — proceed normally
  }
  if (branch.branch_type !== null && branch.branch_type !== undefined) {
    // Established classification is business data — conflicting onboarding
    // FAILS, it never reclassifies (§10/§11).
    throw new AppError(
      `Branch ${branch.code} is already classified as ${branch.branch_type}`,
      409,
      'BRANCH_TYPE_CONFLICT'
    );
  }

  // NULL → establish. Atomic conditional guard: only ever flips NULL, so a
  // concurrent winner can never be overwritten even without the row lock.
  const [result] = await connection.execute(
    'UPDATE branches SET branch_type = ? WHERE id = ? AND branch_type IS NULL',
    [parsed.branchType, branchId]
  );
  if (result.affectedRows === 0) {
    const [recheck] = await connection.execute(
      'SELECT branch_type FROM branches WHERE id = ?',
      [branchId]
    );
    if (recheck[0]?.branch_type === parsed.branchType) return null; // identical concurrent classification
    throw new AppError(
      `Branch ${branch.code} was concurrently classified as ${recheck[0]?.branch_type}`,
      409,
      'BRANCH_TYPE_CONFLICT'
    );
  }
  return { branchId: branch.id, branchCode: branch.code, oldType: null, newType: parsed.branchType };
};

/**
 * NEW EMPLOYEE (admin user-management create — this app creates EMPLOYEEs
 * only through that path; ADMIN accounts are exempt by role, §8).
 *
 * - Branch selected → managed username REQUIRED (§5), code must match,
 *   branch classified/validated.
 * - No branch + MANAGED username → USERNAME_BRANCH_REQUIRED: a
 *   branch-coded username must not silently classify nothing (§15).
 * - No branch + non-managed username → allowed: an unassigned employee is a
 *   valid existing state in this app (warranty creation later requires a
 *   branch via INCOMPLETE_PROFILE), and Beta-2 preserves that optionality.
 */
const enforceForCreate = async (connection, { role, username, branchId }) => {
  if (role !== 'EMPLOYEE') return { parsed: null, classification: null };

  const parsed = parseManagedEmployeeUsername(username);

  if (!branchId) {
    if (parsed.managed) {
      throw new AppError(
        `Username ${username} names branch ${parsed.branchCode} — select that branch`,
        400,
        'USERNAME_BRANCH_REQUIRED'
      );
    }
    return { parsed: null, classification: null }; // unassigned employee, legacy-style name — allowed
  }

  if (!parsed.managed) {
    throw new AppError(
      'Employee username must follow the managed format, e.g. eg_ali_01_1',
      400,
      parsed.reason
    );
  }

  const classification = await classifyBranchForManagedEmployee(connection, { parsed, branchId });
  return { parsed, classification };
};

/**
 * EMPLOYEE UPDATE. In this app the update API only accepts
 * full_name/phone/branch_id — username and role are immutable — so the only
 * enforcement trigger is a BRANCH CHANGE:
 *
 * - branch unchanged (incl. still-null) → unrelated edit: NEVER blocked, no
 *   classification touched — legacy usernames keep working (§9 Case E).
 * - branch removed (→ null) → allowed (existing optionality preserved); the
 *   old branch is NOT declassified (§12).
 * - branch changed, managed username → suffix must match the NEW branch
 *   (else USERNAME_BRANCH_MISMATCH) and the target branch is
 *   classified/validated exactly like create; the OLD branch's
 *   classification is never touched (§14 Case B).
 * - branch changed, LEGACY username → rejected: assigning a branch is
 *   exactly the moment the convention becomes mandatory (§9), and since
 *   usernames are immutable here, moving such an employee requires
 *   recreating the account with a managed name (reported as an operational
 *   consequence).
 */
const enforceForUpdate = async (connection, { existingUser, newBranchId }) => {
  if (existingUser.role !== 'EMPLOYEE') return { parsed: null, classification: null };

  const normalizedNew = newBranchId || null;
  const branchChanged = String(normalizedNew) !== String(existingUser.branch_id || null);
  if (!branchChanged || normalizedNew === null) {
    return { parsed: null, classification: null };
  }

  const parsed = parseManagedEmployeeUsername(existingUser.username);
  if (!parsed.managed) {
    // Beta-2.1: a DEDICATED error code — a generic username-format error
    // here would mislead the admin (they didn't type a username at all,
    // they moved a branch). Usernames are immutable via this API, so
    // moving a legacy-named employee means creating a new account with a
    // managed username.
    throw new AppError(
      'Moving a legacy-named employee requires creating a new account with a managed username (e.g. eg_ali_01_1)',
      400,
      'LEGACY_EMPLOYEE_BRANCH_CHANGE'
    );
  }

  const classification = await classifyBranchForManagedEmployee(connection, { parsed, branchId: normalizedNew });
  return { parsed, classification };
};

/**
 * EXPLICIT ADMIN RECLASSIFICATION (Beta-2.1) — an exceptional corrective
 * operation, NOT normal onboarding. Super-Admin-gated at the route.
 * MUST run inside the caller's open transaction: the branch row is read
 * FOR UPDATE — the SAME lock employee onboarding takes — so a concurrent
 * onboarding and a reclassification of one branch always serialize; no
 * committed state can ever pair branch_type=X with a managed employee whose
 * prefix establishes Y.
 *
 * Consistency rule: the branch's currently assigned EMPLOYEE accounts are
 * the evidence. A managed username whose reconstructed code MATCHES this
 * branch's code establishes its prefix's type; legacy/unparseable usernames
 * (and code-mismatched managed ones — a historical anomaly that cannot
 * speak for THIS branch) provide no type evidence, only a logged note.
 * Deliberately conservative: ALL assigned employees count, including
 * disabled ones (re-enabling is one click — a disabled eg_* installer must
 * not silently become attached to a STAG branch).
 *
 *   target = concrete type → allowed iff every evidence type equals it
 *            (no evidence = allowed; identical evidence = allowed, which
 *            also covers restoring consistency over a bad historical state).
 *   target = null (reset to UNCLASSIFIED) → allowed iff NO evidence exists.
 *   anything else → 409 BRANCH_RECLASSIFICATION_CONFLICT, type untouched.
 *
 * Never renames employees, never rewrites their branch_id — users are
 * read-only here.
 */
const reclassifyBranch = async (connection, { branchId, targetType }) => {
  if (targetType !== null && !BRANCH_TYPES.includes(targetType)) {
    throw new AppError('branch_type must be EASYGAS, STAG_SERVICE, OTHER_SERVICE or null', 400, 'VALIDATION_ERROR');
  }

  const [rows] = await connection.execute(
    'SELECT id, code, branch_type FROM branches WHERE id = ? FOR UPDATE',
    [branchId]
  );
  const branch = rows[0];
  if (!branch) {
    throw new AppError('Branch not found', 404, 'BRANCH_NOT_FOUND');
  }

  const [employees] = await connection.execute(
    "SELECT id, username, is_active FROM users WHERE branch_id = ? AND role = 'EMPLOYEE'",
    [branchId]
  );
  const evidence = new Set();
  let legacyCount = 0;
  for (const employee of employees) {
    const parsed = parseManagedEmployeeUsername(employee.username);
    if (parsed.managed && parsed.branchCode === branch.code) {
      evidence.add(parsed.branchType);
    } else {
      legacyCount += 1;
    }
  }

  const conflicting = [...evidence].filter((tName) => tName !== targetType);
  if (targetType === null ? evidence.size > 0 : conflicting.length > 0) {
    throw new AppError(
      `Branch ${branch.code} has managed employees establishing ${[...evidence].join(', ')} — reclassification would contradict them`,
      409,
      'BRANCH_RECLASSIFICATION_CONFLICT'
    );
  }

  const oldType = branch.branch_type ?? null;
  if (oldType === targetType) {
    return { branch, oldType, newType: targetType, changed: false, legacyCount };
  }

  await connection.execute(
    'UPDATE branches SET branch_type = ? WHERE id = ?',
    [targetType, branchId]
  );
  return { branch, oldType, newType: targetType, changed: true, legacyCount };
};

module.exports = { enforceForCreate, enforceForUpdate, classifyBranchForManagedEmployee, reclassifyBranch, logBranchClassification };
