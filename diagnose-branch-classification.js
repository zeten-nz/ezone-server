/**
 * READ-ONLY Beta-2 diagnostic — run by hand (node diagnose-branch-classification.js)
 * against the real database before/after deploying the branch_type change.
 * Executes SELECTs ONLY: it never writes, never classifies, never fixes
 * anything — historical users/branches are never bulk-modified from this
 * report (explicit Beta-2 rule).
 *
 * Reports:
 *   - total branches, and how many are unclassified (branch_type NULL)
 *   - branch_type distribution
 *   - how many EMPLOYEE usernames already match the eg/st/bs managed pattern
 *   - managed usernames whose derived branch code MISMATCHES their assigned
 *     branch's code (would fail USERNAME_BRANCH_MISMATCH on a future branch
 *     change)
 *   - managed usernames whose prefix CONFLICTS with their branch's already-
 *     persisted branch_type (would fail BRANCH_TYPE_CONFLICT)
 *   - managed usernames pointing at branches that are still NULL (candidates
 *     that would classify those branches if re-onboarded — listed only,
 *     never applied)
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const { parseManagedEmployeeUsername } = require('./utils/managedUsername');

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
  });

  const [[{ totalBranches }]] = await connection.execute('SELECT COUNT(*) AS totalBranches FROM branches');
  const [typeRows] = await connection.execute(
    "SELECT COALESCE(branch_type, 'NULL (unclassified)') AS t, COUNT(*) AS n FROM branches GROUP BY branch_type"
  );
  console.log(`Branches: ${totalBranches}`);
  for (const r of typeRows) console.log(`  ${r.t}: ${r.n}`);

  const [employees] = await connection.execute(
    `SELECT u.id, u.username, u.branch_id, b.code AS branch_code, b.branch_type
     FROM users u LEFT JOIN branches b ON b.id = u.branch_id
     WHERE u.role = 'EMPLOYEE'`
  );
  const managed = [];
  const mismatches = [];
  const typeConflicts = [];
  const wouldClassify = [];
  for (const u of employees) {
    const parsed = parseManagedEmployeeUsername(u.username);
    if (!parsed.managed) continue;
    managed.push(u.username);
    if (!u.branch_id) continue;
    if (parsed.branchCode !== u.branch_code) {
      mismatches.push(`  #${u.id} ${u.username} → ${parsed.branchCode}, assigned branch is ${u.branch_code}`);
    } else if (u.branch_type && u.branch_type !== parsed.branchType) {
      typeConflicts.push(`  #${u.id} ${u.username} → ${parsed.branchType}, branch ${u.branch_code} is ${u.branch_type}`);
    } else if (!u.branch_type) {
      wouldClassify.push(`  branch ${u.branch_code} ← ${parsed.branchType} (via ${u.username})`);
    }
  }
  console.log(`\nEMPLOYEE accounts: ${employees.length}`);
  console.log(`  already matching the managed eg/st/bs pattern: ${managed.length}`);
  console.log(`\nUsername↔assigned-branch code mismatches: ${mismatches.length}`);
  mismatches.forEach((l) => console.log(l));
  console.log(`\nPrefix↔persisted-branch-type conflicts: ${typeConflicts.length}`);
  typeConflicts.forEach((l) => console.log(l));
  console.log(`\nStill-NULL branches that a managed username points at (informational only, NOT applied): ${wouldClassify.length}`);
  wouldClassify.forEach((l) => console.log(l));
  console.log('\nRead-only diagnostic complete — nothing was modified.');

  await connection.end();
}

main().catch((error) => { console.error('Diagnostic failed:', error.message); process.exit(1); });
