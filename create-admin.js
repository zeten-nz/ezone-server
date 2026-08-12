/**
 * STANDALONE admin-account bootstrap utility — the documented way to create
 * the first ADMIN user on a fresh production database (mock data, which
 * seeds a dev admin, is hard-disabled in production — see server.js).
 * Referenced by `npm run create-admin` and README.production.md; this file
 * recreates that documented tool, which was missing from the repository.
 *
 * Usage:
 *   node create-admin.js <username> <password> [full name] [--super]
 *
 *   --super  additionally grants is_super_admin (required for points
 *            configuration and manual point adjustments — see
 *            middleware/auth.js's requireSuperAdmin).
 *
 * Safe by design:
 *   - refuses to overwrite an existing username (never an UPDATE);
 *   - hashes with the same bcryptjs cost (10) authController uses, so
 *     login/change-password work identically to any other account;
 *   - never prints the password back;
 *   - additive only — runs against the existing schema, no migrations.
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const args = process.argv.slice(2).filter((a) => a !== '--super');
const isSuper = process.argv.includes('--super');
const [username, password, fullName] = args;

if (!username || !password) {
  console.error('Usage: node create-admin.js <username> <password> [full name] [--super]');
  process.exit(1);
}
if (password.length < 8) {
  console.error('REFUSED: password must be at least 8 characters.');
  process.exit(1);
}

(async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ezone',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
  });
  try {
    const [existing] = await connection.execute('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) {
      console.error(`REFUSED: username '${username}' already exists (id=${existing[0].id}). This tool never overwrites accounts.`);
      process.exit(1);
    }

    const hashed = await bcrypt.hash(password, 10);
    // branch_code stays NULL for admins — a placeholder here used to get
    // silently promoted into a real branches row (see config/database.js's
    // cleanupAccidentalAdminBranches), so NULL is the one correct value.
    const [result] = await connection.execute(
      `INSERT INTO users (full_name, username, password, phone, branch_code, role, is_active, is_super_admin)
       VALUES (?, ?, ?, ?, ?, 'ADMIN', TRUE, ?)`,
      [fullName || 'System Administrator', username, hashed, null, null, isSuper]
    );
    console.log(`Admin '${username}' created (id=${result.insertId}${isSuper ? ', super admin' : ''}).`);
  } catch (error) {
    console.error('Error:', error.message);
    process.exitCode = 1;
  } finally {
    await connection.end();
  }
})();
