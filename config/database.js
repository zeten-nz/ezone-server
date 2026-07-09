/**
 * DATABASE CONNECTION POOL
 *
 * Why a pool instead of a single connection?
 *   A single persistent connection is a bottleneck: concurrent API requests
 *   queue behind it. A pool keeps N connections open and hands them out to
 *   request handlers in parallel, then returns them to the pool when done.
 *
 * Key production settings explained:
 *
 *   connectionLimit    — Max simultaneous DB connections (default 10).
 *                        Set via DB_POOL_SIZE in .env. Tune based on your
 *                        MySQL max_connections (typically 151 by default).
 *                        Rule of thumb: (CPU cores × 2) + effective_disk_spindles.
 *
 *   waitForConnections — true: queue the request if the pool is exhausted.
 *                        false: throw immediately. true is correct for production.
 *
 *   queueLimit         — 0 = unlimited queuing. Set to a positive integer if
 *                        you want to reject requests when load is too high.
 *
 *   enableKeepAlive    — Sends periodic TCP keep-alive pings so the OS
 *                        doesn't silently drop idle connections after the
 *                        firewall/NAT idle timeout (often 5 min on cloud VMs).
 *
 *   timezone: '+00:00' — Forces MySQL to return timestamps in UTC.
 *                        Prevents subtle timezone bugs when the server and DB
 *                        host are in different zones.
 *
 *   charset: 'utf8mb4' — Full Unicode support, including emoji and Uzbek/
 *                        Cyrillic characters. 'utf8' in MySQL is limited to
 *                        3 bytes and cannot store 4-byte Unicode code points.
 */

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:     process.env.DB_HOST || 'localhost',
  user:     process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME  || 'ezone',
  port:     parseInt(process.env.DB_PORT, 10) || 3306,

  // Pool sizing — tunable via .env without code changes
  waitForConnections: true,
  connectionLimit:    parseInt(process.env.DB_POOL_SIZE, 10) || 10,
  queueLimit:         0,

  // Keep connections alive through firewall/NAT idle timeouts
  enableKeepAlive:       true,
  keepAliveInitialDelay: 0,

  // Always communicate with MySQL in UTC — never trust the server's local timezone
  timezone: '+00:00',

  // Full Unicode support for Uzbek text, special characters, and emoji
  charset: 'utf8mb4'
});

/**
 * Adds `column` to `table` only if it doesn't already exist — the safe,
 * portable way to evolve a table already deployed with CREATE TABLE IF NOT
 * EXISTS (which does nothing once the table exists). `definition` is the
 * full column clause (name + type + modifiers); both `table`/`column` here
 * are always static strings we control, never request input.
 */
async function ensureColumn(connection, table, column, definition) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows[0].count === 0) {
    await connection.execute(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    console.log(`[DB] Migration: added column ${table}.${column}`);
  }
}

const initializeDatabase = async (loadMockData = false) => {
  let connection;
  try {
    // Acquiring a connection here also serves as a connectivity test.
    // If the DB is unreachable (wrong host/credentials), this throws
    // immediately and the catch block exits the process with a clear error
    // instead of letting the server start in a broken state.
    connection = await pool.getConnection();
    console.log('[DB] Connected to MySQL successfully');

    // Create users table if it doesn't already exist.
    // IF NOT EXISTS makes this idempotent — safe to run on every startup.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id             INT PRIMARY KEY AUTO_INCREMENT,
        full_name      VARCHAR(255) NOT NULL,
        first_name     VARCHAR(255) NULL,
        last_name      VARCHAR(255) NULL,
        username       VARCHAR(100) UNIQUE NOT NULL,
        password       VARCHAR(255) NOT NULL,
        phone          VARCHAR(20),
        region         VARCHAR(100) NULL,
        district       VARCHAR(100) NULL,
        branch_code    VARCHAR(100),
        photo_filename VARCHAR(255) NULL,
        role           ENUM('ADMIN', 'EMPLOYEE') DEFAULT 'EMPLOYEE',
        is_active      BOOLEAN DEFAULT TRUE,
        last_login_at  TIMESTAMP NULL DEFAULT NULL,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // Additive migration for databases created before first_name/last_name/
    // region/district/photo_filename/last_login_at existed — CREATE TABLE IF
    // NOT EXISTS above is a no-op once the table already exists, so an
    // already-deployed `users` table needs these columns added explicitly.
    // Checking information_schema first (rather than a bare ALTER) keeps this
    // safely re-runnable on every startup without erroring on later runs.
    await ensureColumn(connection, 'users', 'first_name', 'first_name VARCHAR(255) NULL AFTER full_name');
    await ensureColumn(connection, 'users', 'last_name', 'last_name VARCHAR(255) NULL AFTER first_name');
    await ensureColumn(connection, 'users', 'region', 'region VARCHAR(100) NULL AFTER phone');
    await ensureColumn(connection, 'users', 'district', 'district VARCHAR(100) NULL AFTER region');
    await ensureColumn(connection, 'users', 'photo_filename', 'photo_filename VARCHAR(255) NULL AFTER branch_code');
    await ensureColumn(connection, 'users', 'last_login_at', 'last_login_at TIMESTAMP NULL DEFAULT NULL AFTER is_active');

    // Create warranty_forms table with FK to users
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS warranty_forms (
        id                           INT PRIMARY KEY AUTO_INCREMENT,
        employee_id                  INT NOT NULL,

        region                       VARCHAR(100) NOT NULL,
        city                         VARCHAR(100) NOT NULL,
        district                     VARCHAR(100) NOT NULL,
        organization_name            VARCHAR(255) NOT NULL,
        organization_phone           VARCHAR(20)  NOT NULL,
        installer_full_name          VARCHAR(255) NOT NULL,
        warranty_book_number         VARCHAR(100) NOT NULL,
        installation_date            DATE         NOT NULL,

        vehicle_brand                VARCHAR(100) NOT NULL,
        vehicle_model                VARCHAR(100) NOT NULL,
        vehicle_production_year      INT          NOT NULL,
        vehicle_plate_number         VARCHAR(50)  NOT NULL,
        vehicle_vin                  VARCHAR(100) NOT NULL,
        vehicle_engine_volume        VARCHAR(50)  NOT NULL,
        vehicle_engine_power         VARCHAR(50)  NOT NULL,
        vehicle_mileage              INT          NOT NULL,
        owner_full_name              VARCHAR(255) NOT NULL,
        owner_phone                  VARCHAR(20)  NOT NULL,

        reducer_fuel_type            ENUM('LPG', 'CNG') NOT NULL,
        reducer_manufacturer         VARCHAR(100) NOT NULL,
        reducer_serial_number        VARCHAR(100) NOT NULL,

        cylinder_fuel_type           ENUM('LPG', 'CNG') NOT NULL,
        cylinder_manufacturer        VARCHAR(100) NOT NULL,
        cylinder_serial_number       VARCHAR(100) NOT NULL,

        stag_controller_manufacturer VARCHAR(100) NOT NULL,
        stag_controller_serial_number VARCHAR(100) NOT NULL,

        injector_rail_manufacturer   VARCHAR(100) NOT NULL,
        injector_rail_serial_number  VARCHAR(100) NOT NULL,

        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        FOREIGN KEY (employee_id) REFERENCES users(id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // Create registration_requests table — new employee accounts start here,
    // PENDING and with zero permissions, until an admin approves them (which
    // is what actually creates the corresponding users row). Never grants
    // login/API access on its own — see authController.login().
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS registration_requests (
        id             INT PRIMARY KEY AUTO_INCREMENT,
        first_name     VARCHAR(255) NOT NULL,
        last_name      VARCHAR(255) NOT NULL,
        region         VARCHAR(100) NOT NULL,
        district       VARCHAR(100) NOT NULL,
        branch_code    VARCHAR(100) NOT NULL,
        phone          VARCHAR(20)  NOT NULL,
        username       VARCHAR(100) NOT NULL,
        password_hash  VARCHAR(255) NOT NULL,
        photo_filename VARCHAR(255) NOT NULL,
        status         ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
        notes          TEXT,
        reviewed_at    TIMESTAMP NULL DEFAULT NULL,
        reviewed_by    INT NULL,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        FOREIGN KEY (reviewed_by) REFERENCES users(id),
        INDEX idx_registration_requests_username (username),
        INDEX idx_registration_requests_status (status)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // Only seed mock data when the database is completely empty AND the
    // LOAD_MOCK_DATA env var hasn't been set to 'false'.
    // This prevents accidental data loss in production if someone restarts
    // the server with LOAD_MOCK_DATA still enabled.
    const [existingUsers] = await connection.execute(
      'SELECT COUNT(*) as count FROM users'
    );
    const hasData = existingUsers[0].count > 0;

    if (loadMockData && !hasData) {
      console.log('[DB] Loading mock data...');
      const { generateMockData } = require('./mockData');
      await generateMockData(connection);
      console.log('[DB] Mock data loaded successfully');
    }

    console.log('[DB] Database initialization complete');
  } catch (error) {
    console.error('[DB] Initialization error:', error.message);
    // Exit the process so PM2 / systemd can restart and retry.
    // A server running without a working database is useless and dangerous.
    process.exit(1);
  } finally {
    // Always release the connection, even if an error was thrown above,
    // to avoid connection leaks that would exhaust the pool.
    if (connection) connection.release();
  }
};

module.exports = { pool, initializeDatabase };
