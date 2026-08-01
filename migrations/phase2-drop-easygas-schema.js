/**
 * PHASE 2 — drop deprecated EasyGas schema.
 *
 * Phase 1 (already complete, see config/database.js) stopped every read/write
 * of these columns/table and left them in place so historical data survived
 * while the rest of the app was verified. This script is Phase 2: the actual
 * DROP. It is NOT run automatically at boot (unlike ensureColumn/ensureTable
 * in config/database.js) — run it by hand, once, only after the application
 * has been fully verified against production data with zero EasyGas reads/
 * writes remaining.
 *
 * Usage:
 *   node migrations/phase2-drop-easygas-schema.js            # dry run — prints what would happen
 *   node migrations/phase2-drop-easygas-schema.js --apply     # actually drops the schema
 *
 * Back up the database before running with --apply. This is irreversible.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const DROPS = [
  { table: 'warranty_forms', columns: [
    'easygas_sync_status',
    'easygas_sync_terminal',
    'easygas_sync_attempts',
    'easygas_sync_claimed_at',
    'easygas_synced_at',
    'easygas_warranty_number',
    'easygas_last_error',
  ] },
  { table: 'branches', columns: ['easygas_stag_code'] },
  { table: 'products', columns: ['external_id', 'synced_at'] },
  { table: 'brands', columns: ['external_id', 'synced_at'] },
  { table: 'cars', columns: ['external_id', 'external_updated_at', 'synced_at'] },
];

const TABLES_TO_DROP = ['sync_state'];

async function columnExists(connection, table, column) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].count > 0;
}

async function tableExists(connection, table) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return rows[0].count > 0;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
  });

  console.log(apply ? '[Phase 2] APPLYING schema drop...' : '[Phase 2] DRY RUN — no changes will be made (pass --apply to execute)');

  for (const { table, columns } of DROPS) {
    for (const column of columns) {
      const exists = await columnExists(connection, table, column);
      if (!exists) {
        console.log(`  [skip] ${table}.${column} already absent`);
        continue;
      }
      console.log(`  [${apply ? 'DROP' : 'would drop'}] ${table}.${column}`);
      if (apply) {
        await connection.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }
    }
  }

  for (const table of TABLES_TO_DROP) {
    const exists = await tableExists(connection, table);
    if (!exists) {
      console.log(`  [skip] table ${table} already absent`);
      continue;
    }
    console.log(`  [${apply ? 'DROP' : 'would drop'}] table ${table}`);
    if (apply) {
      await connection.execute(`DROP TABLE ${table}`);
    }
  }

  await connection.end();
  console.log(apply ? '[Phase 2] Done.' : '[Phase 2] Dry run complete — re-run with --apply to execute.');
}

main().catch((error) => {
  console.error('[Phase 2] Failed:', error);
  process.exit(1);
});
