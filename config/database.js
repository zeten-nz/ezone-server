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

/**
 * Relaxes an existing NOT NULL column to nullable — used for the legacy
 * warranty_forms equipment columns, which are superseded by the
 * warranty_form_products join table but must keep displaying on historical
 * rows. MODIFY COLUMN never loses existing data; this only ever widens the
 * constraint, and only does so once (checked via information_schema first).
 */
/**
 * Repairs a column whose collation drifted from this schema's standard
 * (utf8mb4_unicode_ci, set explicitly on every original CREATE TABLE) to
 * MySQL 8's own default (utf8mb4_0900_ai_ci) — which happens whenever a
 * column is added via ensureColumn/ensureNullableColumn's ALTER without an
 * explicit COLLATE clause. Harmless until two differently-collated VARCHAR
 * columns are compared directly (a JOIN or WHERE ... = another column,
 * never a bound `?` parameter), which throws "Illegal mix of collations"
 * and fails outright — confirmed the hard way by warranty_forms.
 * installer_branch_code vs branches.code (see cleanupAccidentalAdminBranches,
 * which joins the same two columns and had never actually been exercised
 * against a real row with a mismatched collation yet). `definition` must
 * repeat the column's full, unchanged type/
 * nullability/default — MODIFY COLUMN replaces the whole definition, not
 * just the collation.
 */
async function ensureColumnCollation(connection, table, column, definition) {
  const [rows] = await connection.execute(
    `SELECT COLLATION_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows.length > 0 && rows[0].COLLATION_NAME && rows[0].COLLATION_NAME !== 'utf8mb4_unicode_ci') {
    await connection.execute(`ALTER TABLE ${table} MODIFY COLUMN ${definition}`);
    console.log(`[DB] Migration: fixed ${table}.${column} collation (was ${rows[0].COLLATION_NAME})`);
  }
}

async function ensureNullableColumn(connection, table, column, definition) {
  const [rows] = await connection.execute(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows.length > 0 && rows[0].IS_NULLABLE === 'NO') {
    await connection.execute(`ALTER TABLE ${table} MODIFY COLUMN ${definition}`);
    console.log(`[DB] Migration: relaxed ${table}.${column} to nullable`);
  }
}

/**
 * Changes an existing foreign key's ON DELETE rule from CASCADE to RESTRICT.
 * Used where an earlier CASCADE definition allowed a parent-row delete to
 * silently destroy dependent rows with no warning — RESTRICT instead blocks
 * the delete, matching how every other relationship into the parent table
 * already behaves. Idempotent: no-ops once the constraint is already
 * RESTRICT. The constraint name is discovered via information_schema rather
 * than assumed, since CREATE TABLE never gave it an explicit name (MySQL
 * auto-names it, e.g. `<table>_ibfk_<n>`).
 */
async function ensureForeignKeyRestrict(connection, table, column, referencedTable) {
  const [rows] = await connection.execute(
    `SELECT rc.CONSTRAINT_NAME, rc.DELETE_RULE
     FROM information_schema.REFERENTIAL_CONSTRAINTS rc
     JOIN information_schema.KEY_COLUMN_USAGE kcu
       ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
     WHERE rc.CONSTRAINT_SCHEMA = DATABASE() AND rc.TABLE_NAME = ?
       AND kcu.COLUMN_NAME = ? AND kcu.REFERENCED_TABLE_NAME = ?`,
    [table, column, referencedTable]
  );
  if (rows.length > 0 && rows[0].DELETE_RULE === 'CASCADE') {
    const constraintName = rows[0].CONSTRAINT_NAME;
    await connection.execute(`ALTER TABLE ${table} DROP FOREIGN KEY ${constraintName}`);
    await connection.execute(
      `ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${column}) REFERENCES ${referencedTable}(id) ON DELETE RESTRICT`
    );
    console.log(`[DB] Migration: changed ${table}.${column} FK to RESTRICT (was CASCADE)`);
  }
}

/**
 * Renames a column while preserving its data — idempotent via checking the
 * OLD name first, so re-running after the rename already happened is a
 * no-op (the old name simply won't exist anymore). Used for columns whose
 * label changed but whose values must survive untouched (e.g. `region` ->
 * `installer_region`), as opposed to ensureColumn (brand new column) or
 * ensureNullableColumn (same name, widened constraint).
 *
 * `definition` is ONLY the type + constraints (e.g. 'VARCHAR(100) NOT NULL')
 * — MySQL's CHANGE COLUMN syntax already takes new_col_name as its own
 * argument, so `definition` must NOT repeat the column name. Unlike
 * ensureColumn/ensureNullableColumn, where `definition` DOES embed the
 * column name (spliced into ADD COLUMN / MODIFY COLUMN respectively).
 */
async function ensureColumnRenamed(connection, table, oldColumn, newColumn, definition) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, oldColumn]
  );
  if (rows[0].count > 0) {
    await connection.execute(`ALTER TABLE ${table} CHANGE COLUMN ${oldColumn} ${newColumn} ${definition}`);
    console.log(`[DB] Migration: renamed ${table}.${oldColumn} -> ${newColumn}`);
  }
}

/**
 * Drops a UNIQUE/other index if it currently exists — idempotent via
 * information_schema.STATISTICS. Used when a column's real-world meaning
 * changes from "unique physical unit" to "reusable catalog value" (e.g.
 * products.serial_number moving from a per-unit identifier to an unused
 * legacy field once products became a searchable model catalog).
 */
async function ensureIndexDropped(connection, table, indexName) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, indexName]
  );
  if (rows[0].count > 0) {
    await connection.execute(`ALTER TABLE ${table} DROP INDEX ${indexName}`);
    console.log(`[DB] Migration: dropped index ${table}.${indexName}`);
  }
}

/**
 * Adds a plain (non-unique) index if it doesn't already exist — idempotent
 * via information_schema.STATISTICS, mirroring ensureIndexDropped's
 * check-first shape. `columns` is the full parenthesized column list, e.g.
 * '(branch_id, status)'. Used for Phase 4's reporting/filtering indexes on
 * tables that predate them.
 */
async function ensureIndexAdded(connection, table, indexName, columns) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, indexName]
  );
  if (rows[0].count === 0) {
    await connection.execute(`ALTER TABLE ${table} ADD INDEX ${indexName} ${columns}`);
    console.log(`[DB] Migration: added index ${table}.${indexName}`);
  }
}

/**
 * Widens an ENUM column to include a new value — idempotent via parsing the
 * current COLUMN_TYPE from information_schema (e.g. "enum('A','B')") rather
 * than blindly re-running MODIFY COLUMN on every boot. Only ever adds a
 * value; never removes one that existing rows might still use.
 */
async function ensureEnumValue(connection, table, column, fullEnumDefinition, valueToCheck) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows.length > 0 && !rows[0].COLUMN_TYPE.includes(`'${valueToCheck}'`)) {
    await connection.execute(`ALTER TABLE ${table} MODIFY COLUMN ${fullEnumDefinition}`);
    console.log(`[DB] Migration: widened ${table}.${column} to include '${valueToCheck}'`);
  }
}

/**
 * One-time, idempotent promotion of already-typed historical data into the
 * new `branches` table — never fabricates a value. For every distinct
 * branch_code still missing a branch_id, either reuses an existing branches
 * row with that code or creates one (seeded from that branch's own most
 * recent warranty_forms entry, or just the code itself if no history
 * exists), then backfills branch_id. Safe to re-run every boot: only rows
 * with branch_id IS NULL are ever touched.
 */
async function backfillBranches(connection) {
  const findOrCreateBranch = async (code, seedFromWarranty) => {
    const [existing] = await connection.execute('SELECT id FROM branches WHERE code = ?', [code]);
    if (existing.length > 0) return existing[0].id;

    let seed = null;
    if (seedFromWarranty) {
      const [seedRows] = await connection.execute(
        `SELECT wf.installer_branch AS name, wf.organization_phone AS phone,
                wf.installer_region AS region, wf.city AS city, wf.installer_district AS district
         FROM warranty_forms wf
         JOIN users u ON wf.employee_id = u.id
         WHERE u.branch_code = ?
         ORDER BY wf.created_at DESC LIMIT 1`,
        [code]
      );
      seed = seedRows[0] || null;
    }

    const [inserted] = await connection.execute(
      'INSERT INTO branches (code, name, phone, region, district, city) VALUES (?, ?, ?, ?, ?, ?)',
      [code, seed?.name || code, seed?.phone || null, seed?.region || null, seed?.district || null, seed?.city || null]
    );
    console.log(`[DB] Migration: created branch '${code}' from historical data`);
    return inserted.insertId;
  };

  // role != 'ADMIN': an admin account has no physical branch — a
  // branch_code on one is never real historical data worth promoting, only
  // ever a placeholder (see mockData.js). Without this exclusion, an admin
  // seed's placeholder value gets treated identically to a real employee's
  // branch code and silently becomes a permanent, real branches row (see
  // cleanupAccidentalAdminBranches below for the one-time repair of a
  // database that already has this from before this fix).
  const [userCodes] = await connection.execute(
    `SELECT DISTINCT branch_code FROM users WHERE branch_code IS NOT NULL AND branch_code <> '' AND branch_id IS NULL AND role != 'ADMIN'`
  );
  for (const { branch_code } of userCodes) {
    const branchId = await findOrCreateBranch(branch_code, true);
    await connection.execute(
      `UPDATE users SET branch_id = ? WHERE branch_code = ? AND branch_id IS NULL AND role != 'ADMIN'`,
      [branchId, branch_code]
    );
  }

  const [requestCodes] = await connection.execute(
    `SELECT DISTINCT branch_code FROM registration_requests WHERE branch_code IS NOT NULL AND branch_code <> '' AND branch_id IS NULL`
  );
  for (const { branch_code } of requestCodes) {
    const branchId = await findOrCreateBranch(branch_code, false);
    await connection.execute('UPDATE registration_requests SET branch_id = ? WHERE branch_code = ? AND branch_id IS NULL', [branchId, branch_code]);
  }
}

/**
 * One-time repair for a database that already has the bug backfillBranches
 * used to have: an admin account's placeholder branch_code got promoted
 * into a real branches row before the role != 'ADMIN' exclusion above
 * existed. Deliberately not keyed on the literal string 'ADMIN' — it
 * generically detects "a branch that exists only because an admin account
 * points to it," which is the actual failure mode, regardless of what
 * placeholder string produced it. Conservative by construction: only acts
 * when every dependency check below comes back clean, so it can never
 * delete a real branch.
 */
async function cleanupAccidentalAdminBranches(connection) {
  const [candidates] = await connection.execute(`
    SELECT b.id, b.code
    FROM branches b
    WHERE EXISTS (SELECT 1 FROM users u WHERE u.branch_id = b.id AND u.role = 'ADMIN')
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.branch_id = b.id AND u.role != 'ADMIN')
      AND NOT EXISTS (SELECT 1 FROM inventory_items ii WHERE ii.branch_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM warranty_forms wf WHERE wf.installer_branch_code = b.code)
  `);
  for (const branch of candidates) {
    // Clear the referencing column first — users.branch_id -> branches.id
    // has no ON DELETE override (defaults to RESTRICT), so the DELETE below
    // would otherwise fail with a foreign-key violation.
    await connection.execute(`UPDATE users SET branch_id = NULL, branch_code = NULL WHERE branch_id = ? AND role = 'ADMIN'`, [branch.id]);
    await connection.execute(`DELETE FROM branches WHERE id = ?`, [branch.id]);
    console.log(`[DB] Migration: removed accidental admin-only branch '${branch.code}' (id=${branch.id})`);
  }
}

/** Fresh installs otherwise start with zero branches — nothing to pick from at registration. */
async function seedPlaceholderBranches(connection) {
  const [rows] = await connection.execute('SELECT COUNT(*) AS count FROM branches');
  if (rows[0].count > 0) return;

  const placeholders = ['STAG_001', 'STAG_015', 'STAG_022'];
  for (const code of placeholders) {
    await connection.execute('INSERT INTO branches (code, name) VALUES (?, ?)', [code, code]);
  }
  console.log('[DB] Seeded placeholder branches');
}

/**
 * One-time promotion of the old flexible warranty_form_products links (built
 * earlier the same day, superseded almost immediately by the fixed 4-slot
 * warranty_equipment model below) into the new table. INSERT IGNORE against
 * uq_warranty_equipment_type makes this safe to re-run every boot. Products
 * whose category has no equivalent fixed slot (FILLING_VALVE/MULTIVALVE/
 * PRESSURE_SENSOR/FILTER/OTHER) are left in warranty_form_products, untouched
 * — there's no lossy conversion, just nothing to migrate them into. After
 * this runs once, every read path only ever needs a 2-way branch
 * (warranty_equipment vs. the original 4 legacy flat columns) instead of a
 * 3-tier one.
 */
async function migrateWarrantyFormProducts(connection) {
  const [rows] = await connection.execute(
    `SELECT wfp.warranty_form_id, wfp.product_id, p.category, p.fuel_type, p.brand, p.model, p.serial_number
     FROM warranty_form_products wfp JOIN products p ON p.id = wfp.product_id`
  );
  const CATEGORY_TO_EQUIPMENT = { REDUCER: 'REDUCER', CYLINDER: 'CYLINDER', ECU: 'CONTROLLER', INJECTOR_RAIL: 'INJECTOR_RAIL' };
  for (const row of rows) {
    const equipmentType = CATEGORY_TO_EQUIPMENT[row.category];
    if (!equipmentType) continue;
    await connection.execute(
      `INSERT IGNORE INTO warranty_equipment (warranty_form_id, equipment_type, fuel_type, product_id, product_name, serial_number)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.warranty_form_id, equipmentType, row.fuel_type, row.product_id, `${row.brand} ${row.model || ''}`.trim(), row.serial_number]
    );
  }
  if (rows.length > 0) {
    console.log(`[DB] Migration: promoted ${rows.length} warranty_form_products row(s) into warranty_equipment`);
  }
}

/**
 * One-time, idempotent promotion of the old per-row fuel type into the new
 * single top-level warranty_forms.fuel_type column — a warranty has exactly
 * one fuel type for the whole installation, never one per equipment row.
 * Only touches rows with fuel_type IS NULL, so safe to re-run every boot.
 * Resolves via the same 3-tier fallback the dashboard's fuel-type chart
 * already uses: the new REDUCER equipment row's fuel_type (most rows),
 * falling back to the original pre-redesign flat reducer_fuel_type column
 * (oldest historical rows, from before warranty_equipment existed at all).
 */
async function backfillWarrantyFuelType(connection) {
  const [result] = await connection.execute(`
    UPDATE warranty_forms wf
    LEFT JOIN warranty_equipment we
      ON we.warranty_form_id = wf.id AND we.equipment_type = 'REDUCER'
    SET wf.fuel_type = COALESCE(we.fuel_type, wf.reducer_fuel_type)
    WHERE wf.fuel_type IS NULL
      AND (we.fuel_type IS NOT NULL OR wf.reducer_fuel_type IS NOT NULL)
  `);
  if (result.affectedRows > 0) {
    console.log(`[DB] Migration: backfilled fuel_type on ${result.affectedRows} warranty_forms row(s)`);
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

    // Branches are a real entity now — replaces the placeholder static branch
    // list and free-text branch_code as the source of truth for an
    // employee's organization name/phone/location. Created before the
    // users.branch_id column below since that column FKs into this table.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS branches (
        id         INT PRIMARY KEY AUTO_INCREMENT,
        code       VARCHAR(100) UNIQUE NOT NULL,
        name       VARCHAR(255) NOT NULL,
        phone      VARCHAR(20)  NULL,
        region     VARCHAR(100) NULL,
        district   VARCHAR(100) NULL,
        city       VARCHAR(100) NULL,
        is_active  BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    await ensureColumn(
      connection, 'users', 'branch_id',
      'branch_id INT NULL AFTER branch_code, ADD CONSTRAINT fk_users_branch FOREIGN KEY (branch_id) REFERENCES branches(id)'
    );

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

    // The 4 fixed equipment slots are superseded by warranty_form_products
    // (a warranty can now link any number of catalog products, not exactly
    // one reducer/cylinder/controller/injector-rail) — relaxed to nullable
    // so new rows can leave them empty while historical rows keep displaying
    // via these same columns unchanged.
    await ensureNullableColumn(connection, 'warranty_forms', 'reducer_fuel_type', 'reducer_fuel_type ENUM(\'LPG\', \'CNG\') NULL');
    await ensureNullableColumn(connection, 'warranty_forms', 'reducer_manufacturer', 'reducer_manufacturer VARCHAR(100) NULL');
    await ensureNullableColumn(connection, 'warranty_forms', 'reducer_serial_number', 'reducer_serial_number VARCHAR(100) NULL');
    await ensureNullableColumn(connection, 'warranty_forms', 'cylinder_fuel_type', 'cylinder_fuel_type ENUM(\'LPG\', \'CNG\') NULL');
    await ensureNullableColumn(connection, 'warranty_forms', 'cylinder_manufacturer', 'cylinder_manufacturer VARCHAR(100) NULL');
    await ensureNullableColumn(connection, 'warranty_forms', 'cylinder_serial_number', 'cylinder_serial_number VARCHAR(100) NULL');
    await ensureNullableColumn(connection, 'warranty_forms', 'stag_controller_manufacturer', 'stag_controller_manufacturer VARCHAR(100) NULL');
    await ensureNullableColumn(connection, 'warranty_forms', 'stag_controller_serial_number', 'stag_controller_serial_number VARCHAR(100) NULL');
    await ensureNullableColumn(connection, 'warranty_forms', 'injector_rail_manufacturer', 'injector_rail_manufacturer VARCHAR(100) NULL');
    await ensureNullableColumn(connection, 'warranty_forms', 'injector_rail_serial_number', 'injector_rail_serial_number VARCHAR(100) NULL');

    // Installer identity/location snapshot columns are renamed to the
    // installer_* naming the warranty module now uses throughout (data
    // preserved — only the label changes). city/organization_phone are kept
    // under their existing names (still populated from the branch, just no
    // longer headline "installer_*" fields in the API contract).
    await ensureColumnRenamed(connection, 'warranty_forms', 'region', 'installer_region', 'VARCHAR(100) NOT NULL');
    await ensureColumnRenamed(connection, 'warranty_forms', 'district', 'installer_district', 'VARCHAR(100) NOT NULL');
    await ensureColumnRenamed(connection, 'warranty_forms', 'organization_name', 'installer_branch', 'VARCHAR(255) NOT NULL');

    // New installer snapshot fields — the employee's own phone (distinct
    // from organization_phone, the branch's phone) and the branch's code,
    // both captured once at submission time alongside the fields above.
    await ensureColumn(connection, 'warranty_forms', 'installer_phone', 'installer_phone VARCHAR(20) NULL AFTER installer_full_name');
    await ensureColumn(connection, 'warranty_forms', 'installer_branch_code', 'installer_branch_code VARCHAR(100) NULL AFTER installer_branch');

    // Vehicle section redesign: vehicle_name replaces separate brand/model
    // as the single field new submissions collect; vehicle_brand/model stay
    // nullable/legacy for historical display. vehicle_plate_number becomes
    // genuinely optional (many customers have no plate yet). Engine volume
    // /power are dropped from the new form entirely (kept nullable/legacy).
    await ensureColumn(connection, 'warranty_forms', 'vehicle_name', 'vehicle_name VARCHAR(150) NULL AFTER installation_date');
    await ensureNullableColumn(connection, 'warranty_forms', 'vehicle_brand', 'vehicle_brand VARCHAR(100) NULL');
    await ensureNullableColumn(connection, 'warranty_forms', 'vehicle_model', 'vehicle_model VARCHAR(100) NULL');
    await ensureNullableColumn(connection, 'warranty_forms', 'vehicle_plate_number', 'vehicle_plate_number VARCHAR(50) NULL');
    await ensureNullableColumn(connection, 'warranty_forms', 'vehicle_engine_volume', 'vehicle_engine_volume VARCHAR(50) NULL');
    await ensureNullableColumn(connection, 'warranty_forms', 'vehicle_engine_power', 'vehicle_engine_power VARCHAR(50) NULL');

    // Equipment redesign: a warranty has exactly ONE fuel type for the whole
    // installation, not one per equipment row — the old per-row
    // warranty_equipment.fuel_type was a real bug (implied 4 independently-
    // choosable fuel types for a single vehicle conversion). Nullable at the
    // schema level (historical rows have no such value; backfilled once via
    // backfillWarrantyFuelType below); enforced required at the validation
    // layer for all new submissions.
    await ensureColumn(connection, 'warranty_forms', 'fuel_type', 'fuel_type ENUM(\'LPG\', \'CNG\') NULL AFTER installation_date');

    // warranty_book_number: now assigned automatically at creation by
    // warrantyRepository.getNextWarrantyNumber (local sequential
    // W-<year>-<000001>, see the warranty_number_sequences table below) —
    // nullable at the schema level only because historical rows predate
    // that mechanism.
    await ensureNullableColumn(connection, 'warranty_forms', 'warranty_book_number', 'warranty_book_number VARCHAR(100) NULL');
    // submission_uuid: this warranty's own create-idempotency key (protects
    // against a client retrying a POST it doesn't know already succeeded) —
    // no external integration involved.
    await ensureColumn(connection, 'warranty_forms', 'submission_uuid', 'submission_uuid VARCHAR(36) NULL UNIQUE AFTER warranty_book_number');
    // DEPRECATED (EasyGas integration removed) — easygas_sync_status,
    // easygas_sync_terminal, easygas_sync_attempts, easygas_sync_claimed_at,
    // easygas_synced_at, easygas_warranty_number, easygas_last_error below
    // are no longer read or written by any application code. Left in place
    // (idempotent no-ops on every boot after the first) so historical rows
    // stay intact; scheduled for removal in a dedicated future migration
    // once the app has run clean for a while with these untouched.
    await ensureColumn(connection, 'warranty_forms', 'easygas_sync_status', 'easygas_sync_status ENUM(\'PENDING\', \'SYNCING\', \'SYNCED\', \'FAILED\') NOT NULL DEFAULT \'PENDING\' AFTER submission_uuid');
    await ensureColumn(connection, 'warranty_forms', 'easygas_sync_terminal', 'easygas_sync_terminal BOOLEAN NOT NULL DEFAULT FALSE AFTER easygas_sync_status');
    await ensureColumn(connection, 'warranty_forms', 'easygas_sync_attempts', 'easygas_sync_attempts INT NOT NULL DEFAULT 0 AFTER easygas_sync_terminal');
    await ensureColumn(connection, 'warranty_forms', 'easygas_sync_claimed_at', 'easygas_sync_claimed_at TIMESTAMP NULL DEFAULT NULL AFTER easygas_sync_attempts');
    await ensureColumn(connection, 'warranty_forms', 'easygas_synced_at', 'easygas_synced_at TIMESTAMP NULL DEFAULT NULL AFTER easygas_sync_claimed_at');
    await ensureColumn(connection, 'warranty_forms', 'easygas_warranty_number', 'easygas_warranty_number VARCHAR(20) NULL AFTER easygas_synced_at');
    await ensureColumn(connection, 'warranty_forms', 'easygas_last_error', 'easygas_last_error VARCHAR(255) NULL AFTER easygas_warranty_number');

    // ── Warranty status workflow ─────────────────────────────────────────────
    // A warranty's own lifecycle (PENDING -> SUCCESSFUL/REJECTED, admin-
    // reviewed) — a completely different concept from
    // warranty_equipment.verification_status (Manual Verification, a
    // per-equipment-row barcode concern) and unrelated to the DEAD
    // easygas_* columns directly above (those belonged to a different,
    // fully-removed automatic sync-sweep integration). Same review-field
    // shape as registration_requests/warranty_equipment's own review
    // columns (reviewed_by/reviewed_at/review_notes) — one row, one review,
    // no separate log table needed.
    await ensureColumn(connection, 'warranty_forms', 'status', 'status ENUM(\'PENDING\', \'SUCCESSFUL\', \'REJECTED\') NOT NULL DEFAULT \'PENDING\' AFTER easygas_last_error');
    await ensureColumn(
      connection, 'warranty_forms', 'reviewed_by',
      'reviewed_by INT NULL AFTER status, ADD CONSTRAINT fk_warranty_forms_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users(id)'
    );
    await ensureColumn(connection, 'warranty_forms', 'reviewed_at', 'reviewed_at TIMESTAMP NULL DEFAULT NULL AFTER reviewed_by');
    await ensureColumn(connection, 'warranty_forms', 'review_notes', 'review_notes VARCHAR(1000) NULL AFTER reviewed_at');

    // EasyGas sync result — populated exactly once, only after `status`
    // above actually becomes SUCCESSFUL (see warrantyService.reviewWarrantyForm
    // + services/easyGasWarrantySyncService.js). Deliberately new, distinctly-
    // named columns rather than reusing the DEAD easygas_sync_status/
    // easygas_synced_at/easygas_last_error columns above (those belonged to
    // the removed sweep-based integration and are kept untouched purely for
    // historical rows). NOTE: the old phase2-drop-easygas-schema.js migration
    // was DELETED (2026-08-26) — it predated the rebuilt integration and
    // would have dropped the LIVE products/brands/cars external_id+synced_at
    // columns and the LIVE sync_state table. If the dead warranty_forms/
    // branches columns are ever dropped, write a fresh migration against the
    // then-current schema; never drop external_id/synced_at/sync_state.
    await ensureColumn(connection, 'warranty_forms', 'easygas_claim_url', 'easygas_claim_url VARCHAR(500) NULL AFTER review_notes');
    await ensureColumn(connection, 'warranty_forms', 'easygas_sync_result', 'easygas_sync_result ENUM(\'PENDING\', \'SUCCESS\', \'FAILED\') NOT NULL DEFAULT \'PENDING\' AFTER easygas_claim_url');
    await ensureColumn(connection, 'warranty_forms', 'easygas_sync_completed_at', 'easygas_sync_completed_at TIMESTAMP NULL DEFAULT NULL AFTER easygas_sync_result');
    await ensureColumn(connection, 'warranty_forms', 'easygas_sync_error', 'easygas_sync_error VARCHAR(500) NULL AFTER easygas_sync_completed_at');

    // Local, sequential, per-year warranty numbering (W-2026-000001, ...) —
    // see warrantyRepository.getNextWarrantyNumber for the atomic-increment
    // mechanism. One row per year; last_number is the most recently issued
    // sequence number for that year.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS warranty_number_sequences (
        year        INT PRIMARY KEY,
        last_number INT NOT NULL DEFAULT 0
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

    await ensureColumn(
      connection, 'registration_requests', 'branch_id',
      'branch_id INT NULL AFTER branch_code, ADD CONSTRAINT fk_registration_requests_branch FOREIGN KEY (branch_id) REFERENCES branches(id)'
    );

    // Product catalog — every installable physical unit is its own row,
    // identified by a unique serial_number/qr_code. Closed inventory: a row
    // must exist (admin-created) before an installer can look it up, which
    // is what makes installer scoring trustworthy (see warrantyController —
    // scores are never typed in, only ever attached via a real product row).
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS products (
        id            INT PRIMARY KEY AUTO_INCREMENT,
        category      ENUM('REDUCER', 'CYLINDER', 'ECU', 'INJECTOR_RAIL', 'FILLING_VALVE',
                            'MULTIVALVE', 'PRESSURE_SENSOR', 'FILTER', 'OTHER') NOT NULL,
        brand         VARCHAR(100) NOT NULL,
        model         VARCHAR(100) NULL,
        fuel_type     ENUM('LPG', 'CNG') NULL,
        serial_number VARCHAR(150) NOT NULL,
        qr_code       VARCHAR(255) NULL,
        score         INT NOT NULL DEFAULT 0,
        status        ENUM('IN_STOCK', 'INSTALLED', 'RETIRED') NOT NULL DEFAULT 'IN_STOCK',
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_products_serial (serial_number),
        UNIQUE KEY uq_products_qr (qr_code)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // Superseded by warranty_equipment below (kept, never dropped, for any
    // pre-existing rows — see migrateWarrantyFormProducts). No new warranty
    // ever writes here again.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS warranty_form_products (
        id               INT PRIMARY KEY AUTO_INCREMENT,
        warranty_form_id INT NOT NULL,
        product_id       INT NOT NULL,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_wfp_product (product_id),
        INDEX idx_wfp_form (warranty_form_id),
        FOREIGN KEY (warranty_form_id) REFERENCES warranty_forms(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // products is no longer serialized inventory (one row = one physical
    // unit) — it's a searchable catalog of reusable models (e.g. "STAG
    // R02"), selected via autocomplete, with the physical unit's serial
    // typed separately per installation (see warranty_equipment). Old
    // per-unit columns are relaxed/de-indexed rather than dropped.
    await ensureNullableColumn(connection, 'products', 'serial_number', 'serial_number VARCHAR(150) NULL');
    await ensureNullableColumn(connection, 'products', 'qr_code', 'qr_code VARCHAR(255) NULL');
    await ensureIndexDropped(connection, 'products', 'uq_products_serial');
    await ensureIndexDropped(connection, 'products', 'uq_products_qr');
    await ensureColumn(connection, 'products', 'is_active', 'is_active BOOLEAN DEFAULT TRUE AFTER status');
    await ensureEnumValue(
      connection, 'products', 'category',
      `category ENUM('REDUCER','CYLINDER','ECU','INJECTOR_RAIL','FILLING_VALVE',
                      'MULTIVALVE','PRESSURE_SENSOR','FILTER','OTHER','CONTROLLER') NOT NULL`,
      'CONTROLLER'
    );

    // external_id/synced_at: written by easyGasCatalogSyncService.upsertProduct
    // (EasyGas catalog sync reinstated — see services/easyGasCatalogSyncService.js).
    // A prior version of this comment called these columns deprecated/unused;
    // that's no longer accurate as of the catalog-sync-button architecture
    // decision — do not remove.
    await ensureColumn(connection, 'products', 'external_id', 'external_id VARCHAR(100) NULL UNIQUE AFTER model');
    await ensureColumn(connection, 'products', 'synced_at', 'synced_at TIMESTAMP NULL DEFAULT NULL AFTER is_active');

    // One warranty -> exactly one row per fixed equipment type (Reducer/
    // Cylinder/Controller/Injector Rail) — uq_warranty_equipment_type
    // guarantees at most one row per type per warranty; "all 4 required" is
    // enforced in warrantyService/express-validator, not the schema.
    // product_id is NOT NULL + ON DELETE RESTRICT: a warranty can never be
    // submitted without a real catalog product, so a referenced catalog row
    // can never be hard-deleted out from under installed history. The
    // reward_* / validation_* columns are schema-ready for the future STAG
    // validation API but are never populated by any code path yet — every
    // row stays PENDING/NULL until that integration ships.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS warranty_equipment (
        id                           INT PRIMARY KEY AUTO_INCREMENT,
        warranty_form_id             INT NOT NULL,
        equipment_type               ENUM('REDUCER', 'CYLINDER', 'CONTROLLER', 'INJECTOR_RAIL') NOT NULL,
        fuel_type                    ENUM('LPG', 'CNG') NULL,
        product_id                   INT NOT NULL,
        product_name                 VARCHAR(200) NOT NULL,
        serial_number                VARCHAR(150) NULL,
        equipment_validation_status  ENUM('PENDING', 'VALID', 'INVALID') NOT NULL DEFAULT 'PENDING',
        validated_at                 TIMESTAMP NULL DEFAULT NULL,
        reward_points                INT NULL,
        reward_transaction_id        VARCHAR(100) NULL,
        validation_response          JSON NULL,
        created_at                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at                   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_warranty_equipment_type (warranty_form_id, equipment_type),
        FOREIGN KEY (warranty_form_id) REFERENCES warranty_forms(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // ── Brands / Cars: EasyGas-synced catalog ────────────────────────────────
    // Equipment brand catalog (e.g. "STAG", "ADAX") and vehicle catalog (e.g.
    // "Chevrolet Cobalt") — as of the catalog-sync-button architecture
    // decision, EasyGas is the single source of truth for these two tables;
    // admins can view/search/paginate but never create/edit/delete (see
    // routes/brandRoutes.js, routes/carRoutes.js — CRUD routes removed).
    // The only writer is easyGasCatalogSyncService.js's upsertBrand/upsertCar,
    // triggered by the admin "Sync EasyGas Catalog" button (routes/catalogSyncRoutes.js)
    // or the periodic sweep (easyGasCatalogSyncSweep.js). products.brand_id
    // links to brands; warranty_forms.car_id links to cars (free-text
    // fallback always valid when no catalog match exists).
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS brands (
        id          INT PRIMARY KEY AUTO_INCREMENT,
        external_id VARCHAR(100) NULL UNIQUE,
        name        VARCHAR(255) NOT NULL,
        synced_at   TIMESTAMP NULL DEFAULT NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    await ensureColumn(connection, 'brands', 'full_name', 'full_name VARCHAR(255) NULL AFTER name');
    await ensureColumn(connection, 'brands', 'country', 'country VARCHAR(100) NULL AFTER full_name');
    await ensureColumn(connection, 'brands', 'logo_url', 'logo_url VARCHAR(500) NULL AFTER country');
    // is_active: same soft-disable convention as products/cars/branches — a
    // deactivated brand stops appearing in the Product form's Brand select
    // without losing history on any product that already references it.
    await ensureColumn(connection, 'brands', 'is_active', 'is_active BOOLEAN NOT NULL DEFAULT TRUE AFTER logo_url');
    // external_id/synced_at: written by easyGasCatalogSyncService.upsertBrand
    // (EasyGas catalog sync reinstated — not deprecated, see the section
    // comment above).

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cars (
        id                  INT PRIMARY KEY AUTO_INCREMENT,
        external_id         VARCHAR(100) NULL UNIQUE,
        brand               VARCHAR(150) NOT NULL,
        model               VARCHAR(150) NOT NULL,
        external_updated_at TIMESTAMP NULL DEFAULT NULL,
        synced_at           TIMESTAMP NULL DEFAULT NULL,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    // external_id/synced_at: written by easyGasCatalogSyncService.upsertCar
    // (EasyGas catalog sync reinstated — not deprecated, see the section
    // comment above). external_updated_at remains genuinely unused — no
    // per-row updated_at field has ever been confirmed on the real /cars
    // response.

    // One row per paginated, ?updated_since=-capable catalog endpoint (products,
    // cars) — deliberately NOT used for branches/brands, which the contract
    // only documents as small full-list pulls with no incremental-sync fields.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS sync_state (
        sync_key       VARCHAR(50) PRIMARY KEY,
        last_synced_at TIMESTAMP NULL DEFAULT NULL
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // Reuses this same table for the ONE shared "Sync EasyGas Catalog" entry
    // point's Last Sync Time/Status/Message (see
    // easyGasCatalogSyncService.runFullSync) — one extra row keyed
    // sync_key='catalog', distinct from the per-entity 'products'/'cars'
    // checkpoint rows above. last_details holds a per-entity
    // { products: {inserted, updated, skipped, failed}, brands: {...}, cars: {...} }
    // breakdown on success; last_message holds a short machine-readable
    // failure code (e.g. 'brands_failed:network') on failure, translated for
    // display by the admin UI — same errorCode convention already used
    // elsewhere in this app (e.g. 'BRAND_NOT_FOUND', 'PRODUCT_IN_USE').
    await ensureColumn(connection, 'sync_state', 'last_status', "last_status ENUM('SUCCESS', 'FAILED') NULL DEFAULT NULL AFTER last_synced_at");
    await ensureColumn(connection, 'sync_state', 'last_message', 'last_message VARCHAR(500) NULL DEFAULT NULL AFTER last_status');
    await ensureColumn(connection, 'sync_state', 'last_details', 'last_details JSON NULL DEFAULT NULL AFTER last_message');
    // RUNNING added later, once a single sync could be triggered from either
    // the admin button or the periodic sweep and needed a real "don't run
    // twice at once" lock rather than just SUCCESS/FAILED — see
    // easyGasCatalogSyncService.acquireSyncLock. Widening only, never
    // removing a value existing rows might still hold (ensureEnumValue).
    await ensureEnumValue(
      connection, 'sync_state', 'last_status',
      "last_status ENUM('SUCCESS', 'FAILED', 'RUNNING') NULL DEFAULT NULL",
      'RUNNING'
    );
    await ensureColumn(connection, 'sync_state', 'last_duration_ms', 'last_duration_ms INT NULL DEFAULT NULL AFTER last_details');
    // Internal lock bookkeeping only — never read by the admin UI. Lets
    // acquireSyncLock tell "genuinely still running" apart from "crashed
    // mid-run and stuck on RUNNING forever" (see SYNC_LOCK_STALE_MINUTES).
    await ensureColumn(connection, 'sync_state', 'sync_lock_acquired_at', 'sync_lock_acquired_at TIMESTAMP NULL DEFAULT NULL AFTER last_duration_ms');

    // products.brand_id: the real FK a product needs to its local brand.
    // The existing free-text `brand` column is NOT replaced or deprecated —
    // productRepository.create/update denormalizes brands.name into `brand`
    // in the same statement, because productRepository.search/
    // getDistinctBrands and resolveEquipment's derived product_name all read
    // the free-text column today; skipping the dual-write would make a
    // product silently invisible in the exact UI installers use to find
    // equipment.
    await ensureColumn(
      connection, 'products', 'brand_id',
      'brand_id INT NULL AFTER brand, ADD CONSTRAINT fk_products_brand FOREIGN KEY (brand_id) REFERENCES brands(id)'
    );

    // warranty_forms.car_id: nullable — free-text vehicle_name fallback stays
    // valid when no catalog match exists.
    await ensureColumn(
      connection, 'warranty_forms', 'car_id',
      'car_id INT NULL AFTER vehicle_name, ADD CONSTRAINT fk_warranty_forms_car FOREIGN KEY (car_id) REFERENCES cars(id)'
    );

    // DEPRECATED (EasyGas integration removed) — branches.easygas_stag_code is
    // no longer read or written by any application code; left in place so
    // historical rows stay intact, scheduled for removal in a dedicated
    // future migration.
    await ensureColumn(connection, 'branches', 'easygas_stag_code', 'easygas_stag_code VARCHAR(20) NULL AFTER code');

    // Beta-2: branch business-group classification (config/branchTypes.js).
    // ADDITIVE + NULLABLE — every existing branch boots as NULL
    // ("Tayinlanmagan"/unclassified) and STAYS NULL until the authoritative
    // managed-employee onboarding flow classifies it (see
    // services/managedEmployeeService.js). Deliberately NO backfill of any
    // kind: classification is never inferred from branch names/codes/import
    // history and never sourced from EasyGas's /branches endpoint. NULL is
    // independent of is_active — an active unclassified branch is fully
    // valid/selectable.
    await ensureColumn(
      connection, 'branches', 'branch_type',
      "branch_type ENUM('EASYGAS', 'STAG_SERVICE', 'OTHER_SERVICE') NULL DEFAULT NULL AFTER is_active"
    );

    // cars.is_active: same soft-disable convention as products/brands/
    // branches — never hard-delete a car row: warranty_forms.car_id has a
    // real FK to it, and a historical warranty must keep resolving correctly
    // even after a car is retired from the active catalog (deactivate it
    // instead, same as productController.setProductActive).
    await ensureColumn(connection, 'cars', 'is_active', 'is_active BOOLEAN NOT NULL DEFAULT TRUE AFTER model');

    // ── Inventory module (Phase 1) ───────────────────────────────────────────
    // Physical-unit tracking on top of the products catalog. products stays a
    // pure admin-managed catalog — these tables extend it, never write to it.
    // Creation order matters: batches
    // before items (items.import_batch_id references it), items before
    // status_history (history.inventory_item_id references it).
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS inventory_import_batches (
        id                INT PRIMARY KEY AUTO_INCREMENT,
        product_id        INT NOT NULL,
        uploaded_by       INT NOT NULL,
        file_name         VARCHAR(255) NULL,
        total_rows        INT NOT NULL DEFAULT 0,
        imported_count    INT NOT NULL DEFAULT 0,
        skipped_count     INT NOT NULL DEFAULT 0,
        duplicate_count   INT NOT NULL DEFAULT 0,
        error_count       INT NOT NULL DEFAULT 0,
        created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (uploaded_by) REFERENCES users(id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // barcode is globally UNIQUE (not scoped per product) — real serials are
    // unique physical-unit identifiers; the same barcode legitimately
    // existing under a different product later isn't a real case, it's a
    // warehouse error that should surface as a hard conflict, not be allowed.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS inventory_items (
        id                    INT PRIMARY KEY AUTO_INCREMENT,
        product_id            INT NOT NULL,
        barcode               VARCHAR(150) NOT NULL UNIQUE,
        status                ENUM('IN_STOCK', 'RESERVED', 'INSTALLED', 'RETURNED', 'DAMAGED', 'LOST') NOT NULL DEFAULT 'IN_STOCK',
        branch_id             INT NULL,
        import_batch_id       INT NULL,
        created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_inventory_product_status (product_id, status),
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (branch_id) REFERENCES branches(id),
        FOREIGN KEY (import_batch_id) REFERENCES inventory_import_batches(id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // Every status transition, system- or admin-driven (changed_by NULL for
    // the former). Written by claimForInstallation/release/changeStatus —
    // never by a bare UPDATE elsewhere in the codebase.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS inventory_status_history (
        id                INT PRIMARY KEY AUTO_INCREMENT,
        inventory_item_id INT NOT NULL,
        from_status       VARCHAR(20) NULL,
        to_status         VARCHAR(20) NOT NULL,
        changed_by        INT NULL,
        reason            VARCHAR(255) NULL,
        created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE,
        FOREIGN KEY (changed_by) REFERENCES users(id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // ── Inventory module (Phase 2) ───────────────────────────────────────────
    // Links a warranty's equipment row to the specific physical unit claimed
    // for it — nullable, since historical (pre-Phase-2) rows have none, and
    // that's permanent, not a gap to backfill (see the Phase 2 plan).
    // ON DELETE SET NULL: no path exists today to hard-delete an
    // inventory_items row, but if one's ever added, note that
    // equipmentRepository.upsertMany's change-detection compares
    // serial_number, not this column — a future hard-delete would silently
    // null this FK without that diff noticing. Not exploitable today.
    await ensureColumn(
      connection, 'warranty_equipment', 'inventory_item_id',
      'inventory_item_id INT NULL AFTER serial_number, ADD CONSTRAINT fk_warranty_equipment_inventory_item FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE SET NULL'
    );

    // ── Inventory module (Phase 3) — installer points ledger ────────────────
    // Deliberately does NOT touch warranty_equipment's dormant reward_points/
    // reward_transaction_id/etc. columns — those are reserved for a separate,
    // still-unbuilt external STAG validation API integration (reward_transaction_id
    // is a VARCHAR sized for an external API's id string, not an internal FK).
    // No denormalized "current points" column anywhere either: the ledger is
    // small enough that SUM(points) queries are always cheap and always
    // correct, which avoids an entire class of cache-drift bug a stored
    // balance would reintroduce.

    // Current point value per product. Absence of a row means 0 (unconfigured),
    // not a special NULL state — avoids a backfill migration touching every
    // existing product. is_active gate/products.category etc. are all
    // read from `products` directly; this table only ever holds the point value.
    // product_id FK is RESTRICT, not CASCADE: a product with a configured
    // point value is real, meaningful data that must never silently vanish.
    // This matches how every other table referencing `products` already
    // behaves (warranty_equipment/inventory_items/point_transactions/
    // inventory_import_batches all RESTRICT). Note: productController.js no
    // longer exposes a delete/deactivate path at all — EasyGas sync is now
    // the only writer to `products` (see the catalog-sync-button
    // architecture decision) — but the RESTRICT itself stays correct
    // regardless, since a product with history should never be removable.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS product_point_configs (
        product_id  INT PRIMARY KEY,
        points      INT NOT NULL DEFAULT 0,
        updated_by  INT NULL,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
        FOREIGN KEY (updated_by) REFERENCES users(id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // Audit trail for the config VALUE itself ("who changed the reducer from
    // 20 to 30, when") — a different question from the point_transactions
    // ledger below ("why does installer X have N points"). Never affects
    // already-awarded points; those are frozen onto their own ledger rows.
    // Same RESTRICT reasoning as product_point_configs above — an audit
    // trail that CASCADE-deletes itself the moment its subject is deleted
    // isn't an audit trail.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS product_point_config_history (
        id          INT PRIMARY KEY AUTO_INCREMENT,
        product_id  INT NOT NULL,
        old_points  INT NULL,
        new_points  INT NOT NULL,
        changed_by  INT NOT NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
        FOREIGN KEY (changed_by) REFERENCES users(id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // Existing databases created these tables before the fix above — the
    // CREATE TABLE IF NOT EXISTS text change alone does nothing for them,
    // so their live FK constraints need altering explicitly.
    await ensureForeignKeyRestrict(connection, 'product_point_configs', 'product_id', 'products');
    await ensureForeignKeyRestrict(connection, 'product_point_config_history', 'product_id', 'products');

    // Point value for a TYPED equipment slot — currently only ever meaningful
    // for CYLINDER, the one equipment type that can be submitted with no
    // product_id at all (a free-text brand/capacity instead of a catalog
    // pick — see the typed-cylinder work in warrantyService.js). Without
    // this, a typed cylinder always earns 0 points (product_point_configs is
    // keyed by product_id, which a typed cylinder never has), which
    // incentivizes an installer to falsely pick a catalog product instead of
    // accurately reporting an off-catalog one. Keyed by equipment_type (not a
    // sentinel product_id) so it can never be
    // confused with a real product's config. The other 3 enum values will
    // realistically never have a row — kept in the ENUM only for consistency
    // with every other equipment_type column in this schema.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS equipment_type_point_configs (
        equipment_type ENUM('REDUCER', 'CYLINDER', 'CONTROLLER', 'INJECTOR_RAIL') PRIMARY KEY,
        points         INT NOT NULL DEFAULT 0,
        updated_by     INT NULL,
        updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (updated_by) REFERENCES users(id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // Audit trail for the config VALUE itself, mirroring
    // product_point_config_history's exact reasoning.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS equipment_type_point_config_history (
        id             INT PRIMARY KEY AUTO_INCREMENT,
        equipment_type ENUM('REDUCER', 'CYLINDER', 'CONTROLLER', 'INJECTOR_RAIL') NOT NULL,
        old_points     INT NULL,
        new_points     INT NOT NULL,
        changed_by     INT NOT NULL,
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (changed_by) REFERENCES users(id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // The installer points ledger — append-only, never UPDATEd or DELETEd by
    // any code path. warranty_form_id/warranty_equipment_id are ON DELETE SET
    // NULL, not CASCADE: deleting a warranty must never delete its point
    // history. `reason` is written as a frozen, human-readable string at
    // creation time (e.g. "Warranty #152 — REDUCER — LANDIRENZO CN04"), so a
    // row stays fully self-describing even after its FK targets go NULL post-
    // deletion — mirrors the products.brand+brand_id / serial_number+
    // inventory_item_id denormalization precedent already used twice in this
    // codebase. idempotency_key is only ever set by manual adjustments
    // (warranty-driven rows are already covered by submission_uuid's guard on
    // the whole warranty transaction); MySQL allows multiple NULLs under a
    // UNIQUE index, so that's safe.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS point_transactions (
        id                      INT PRIMARY KEY AUTO_INCREMENT,
        installer_id            INT NOT NULL,
        points                  INT NOT NULL,
        transaction_type        ENUM('WARRANTY_AWARD','WARRANTY_REVERSAL','MANUAL_ADJUSTMENT','MANUAL_BONUS','MANUAL_PENALTY') NOT NULL,
        warranty_form_id        INT NULL,
        warranty_equipment_id   INT NULL,
        product_id              INT NULL,
        reversed_transaction_id INT NULL,
        reason                  VARCHAR(255) NULL,
        idempotency_key         VARCHAR(100) NULL UNIQUE,
        created_by              INT NOT NULL,
        created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (installer_id) REFERENCES users(id),
        FOREIGN KEY (created_by) REFERENCES users(id),
        FOREIGN KEY (warranty_form_id) REFERENCES warranty_forms(id) ON DELETE SET NULL,
        FOREIGN KEY (warranty_equipment_id) REFERENCES warranty_equipment(id) ON DELETE SET NULL,
        FOREIGN KEY (product_id) REFERENCES products(id),
        FOREIGN KEY (reversed_transaction_id) REFERENCES point_transactions(id),
        INDEX idx_point_transactions_installer (installer_id, created_at),
        INDEX idx_point_transactions_warranty_equipment (warranty_equipment_id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // Super Admin permission tier: additive flag on top of the existing
    // ADMIN role (not a 3rd ENUM value) — a Super Admin is "an Admin plus
    // this capability flag," so every existing authorizeRole('ADMIN') check
    // anywhere in the app keeps working unchanged. Only gates point-value
    // configuration and manual point adjustments (see middleware/auth.js's
    // requireSuperAdmin).
    await ensureColumn(connection, 'users', 'is_super_admin', 'is_super_admin BOOLEAN NOT NULL DEFAULT FALSE AFTER role');

    // ── Inventory module (Phase 4) — reporting, warehouse, manual ops ───────
    // "Warehouse" is not a new entity — it's the existing `branches` table
    // (confirmed decision, Phase 4 plan). inventory_items.branch_id already
    // existed (added speculatively, never populated) — Phase 4 is what
    // finally writes it, via CSV import and the new branch-transfer op.

    // MERGED is a 6th terminal status for "this barcode was a duplicate of
    // another real item" (see mergeDuplicate) — additive ENUM widen, same
    // pattern as the earlier CONTROLLER category widen. merged_into_id
    // points at the canonical item a duplicate was merged into; ON DELETE
    // SET NULL since losing that pointer shouldn't cascade-delete the
    // (already terminal, historical) duplicate row itself.
    await ensureEnumValue(
      connection, 'inventory_items', 'status',
      `status ENUM('IN_STOCK','RESERVED','INSTALLED','RETURNED','DAMAGED','LOST','MERGED') NOT NULL DEFAULT 'IN_STOCK'`,
      'MERGED'
    );
    await ensureColumn(
      connection, 'inventory_items', 'merged_into_id',
      'merged_into_id INT NULL AFTER branch_id, ADD CONSTRAINT fk_inventory_items_merged_into FOREIGN KEY (merged_into_id) REFERENCES inventory_items(id) ON DELETE SET NULL'
    );

    // Audit trail for the three manual corrections that don't fit
    // inventory_status_history's from/to-status shape (branch transfer,
    // barcode correction, merge) — manual STATUS changes keep using the
    // existing insertStatusHistory path, not this table. reason is NOT NULL:
    // every manual action here is human-triggered and must explain itself.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS inventory_audit_log (
        id                INT PRIMARY KEY AUTO_INCREMENT,
        inventory_item_id INT NOT NULL,
        action_type       ENUM('BRANCH_TRANSFER', 'BARCODE_CORRECTED', 'MERGED_DUPLICATE') NOT NULL,
        old_value         VARCHAR(255) NULL,
        new_value         VARCHAR(255) NULL,
        reason            VARCHAR(255) NOT NULL,
        changed_by        INT NOT NULL,
        created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE,
        FOREIGN KEY (changed_by) REFERENCES users(id),
        INDEX idx_inventory_audit_item (inventory_item_id, created_at)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);

    // Reporting/filtering indexes for tables that predate Phase 4's query
    // shapes (status breakdowns, warehouse-scoped stock, date-range
    // filters, sync-status success %, points-over-time).
    await ensureIndexAdded(connection, 'inventory_items', 'idx_inventory_branch_status', '(branch_id, status)');
    await ensureIndexAdded(connection, 'inventory_status_history', 'idx_inventory_status_history_created_at', '(created_at)');
    await ensureIndexAdded(connection, 'inventory_status_history', 'idx_inventory_status_history_item_created', '(inventory_item_id, created_at)');
    await ensureIndexAdded(connection, 'warranty_forms', 'idx_warranty_forms_sync_status', '(easygas_sync_status)');
    await ensureIndexAdded(connection, 'warranty_forms', 'idx_warranty_forms_installation_date', '(installation_date)');
    await ensureIndexAdded(connection, 'point_transactions', 'idx_point_transactions_created_at', '(created_at)');

    // ── Typed cylinder support (open cylinder input) ────────────────────────
    // The local catalog can never carry every real-world cylinder in the
    // field, so a cylinder may be entered as free text (brand_name +
    // model/capacity) instead of a catalog product_id. The other 3
    // equipment types are unaffected and still always require one.
    await ensureNullableColumn(connection, 'warranty_equipment', 'product_id', 'product_id INT NULL');
    await ensureColumn(connection, 'warranty_equipment', 'brand_name', 'brand_name VARCHAR(150) NULL AFTER serial_number');
    await ensureColumn(connection, 'warranty_equipment', 'model', 'model VARCHAR(100) NULL AFTER brand_name');

    // ── Manual Verification workflow ─────────────────────────────────────────
    // Some installers receive genuine STAG products whose barcode sticker is
    // damaged, unreadable, was never imported, or belongs to old stock that
    // predates this app's inventory tracking entirely — none of that means
    // the installation is fraudulent, so rejecting the warranty outright (the
    // only option before this) is the wrong call. An equipment row whose
    // barcode genuinely resolves to BARCODE_NOT_FOUND (never any other
    // validateBarcode failure — see inventoryService.validateBarcodeOrAcceptManual)
    // may instead be submitted with seller info in place of a claimed
    // inventory item, pending admin review.
    //
    // Lives on warranty_equipment, not warranty_forms: the problem is almost
    // always one damaged sticker out of four, not the whole installation, and
    // every downstream effect this touches (points, inventory claims) is
    // already tracked per equipment row, never per warranty.
    //
    // verification_status alone captures both "how was this row identified"
    // and "what's its current review state" — AUTO means the ordinary barcode
    // path (every historical row, and the default for every new one), so no
    // row can ever be both AUTO and pending review; a second "method" column
    // would be redundant. Deliberately NOT reusing the existing dormant
    // equipment_validation_status column above — that one is reserved for a
    // different, future, external STAG validation API integration, and
    // sharing it here would collide with that the moment it ships.
    await ensureColumn(connection, 'warranty_equipment', 'verification_status', 'verification_status ENUM(\'AUTO\', \'PENDING\', \'APPROVED\', \'REJECTED\') NOT NULL DEFAULT \'AUTO\' AFTER model');
    await ensureColumn(connection, 'warranty_equipment', 'seller_name', 'seller_name VARCHAR(255) NULL AFTER verification_status');
    await ensureColumn(connection, 'warranty_equipment', 'seller_phone', 'seller_phone VARCHAR(20) NULL AFTER seller_name');
    // Named verification_comment, not `comment` — COMMENT is a reserved word
    // in MySQL's own column/table-definition syntax. The API/JS field name
    // is `comment` (see warranty.service.js's toWirePayload and
    // warrantyRoutes.js's validator) — this column is where it's persisted;
    // the two names refer to the exact same value, just DB vs wire naming,
    // never renamed to keep both call sites' existing contracts unchanged.
    // Not to be confused with review_notes below, a completely different
    // field: this one is the INSTALLER's explanation submitted with the
    // claim; review_notes is the ADMIN's own note recorded at approve/reject
    // time — two different authors, two different points in the workflow.
    await ensureColumn(connection, 'warranty_equipment', 'verification_comment', 'verification_comment VARCHAR(1000) NULL AFTER seller_phone');
    await ensureColumn(connection, 'warranty_equipment', 'manual_verification_photo_filename', 'manual_verification_photo_filename VARCHAR(255) NULL AFTER verification_comment');
    // reviewed_by/reviewed_at/review_notes mirror registration_requests'
    // own review columns exactly — same shape, same reasoning: one row, one
    // review, no separate log table needed for a single reviewer decision.
    // review_notes is the admin's own note — see verification_comment above
    // for how it differs from the installer's submitted comment.
    await ensureColumn(
      connection, 'warranty_equipment', 'reviewed_by',
      'reviewed_by INT NULL AFTER manual_verification_photo_filename, ADD CONSTRAINT fk_warranty_equipment_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users(id)'
    );
    await ensureColumn(connection, 'warranty_equipment', 'reviewed_at', 'reviewed_at TIMESTAMP NULL DEFAULT NULL AFTER reviewed_by');
    await ensureColumn(connection, 'warranty_equipment', 'review_notes', 'review_notes VARCHAR(1000) NULL AFTER reviewed_at');

    // Admin "pending manual verification" list/filter — same reporting-index
    // convention as idx_warranty_forms_sync_status below.
    await ensureIndexAdded(connection, 'warranty_equipment', 'idx_warranty_equipment_verification_status', '(verification_status)');

    // Manual Verification workflow — photo upload ownership tracking (review
    // fix: a bare client-submitted filename string must never be trusted on
    // its own; only a filename this exact user actually uploaded may be
    // attached to their submission — see inventoryService.resolveOwnedPhotoFilename).
    // Also doubles as the source of truth for orphaned-upload cleanup
    // (services/manualVerificationUploadCleanupSweep.js): a row here with no
    // matching warranty_equipment.manual_verification_photo_filename after a
    // grace period was uploaded but never actually used in a submission.
    // Deliberately NOT a FK to warranty_equipment (an upload may never end up
    // attached to anything, or may be superseded by a later re-upload before
    // the warranty is even saved) — the relationship is discovered by
    // matching filenames at read time, not stored as a foreign key.
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS manual_verification_photo_uploads (
        id          INT PRIMARY KEY AUTO_INCREMENT,
        filename    VARCHAR(255) NOT NULL UNIQUE,
        uploaded_by INT NOT NULL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (uploaded_by) REFERENCES users(id)
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

    // Runs after mock-data seeding (if any) so it always sees the final set
    // of branch_code values, whether real historical data or freshly-seeded
    // dev data — see backfillBranches/seedPlaceholderBranches above. Must
    // run before cleanupAccidentalAdminBranches — see ensureColumnCollation's
    // header comment for the real incident this fixes.
    await ensureColumnCollation(connection, 'warranty_forms', 'installer_branch_code', 'installer_branch_code VARCHAR(100) NULL COLLATE utf8mb4_unicode_ci');
    await backfillBranches(connection);
    await cleanupAccidentalAdminBranches(connection);
    await seedPlaceholderBranches(connection);
    await migrateWarrantyFormProducts(connection);
    await backfillWarrantyFuelType(connection);

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
