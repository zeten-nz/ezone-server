require('dotenv').config();
const mysql = require('mysql2/promise');

// DESTRUCTIVE: drops and recreates the entire database. Two safety gates,
// same explicit-opt-in convention as test-easygas.js's --send flag:
//   1. Hard-refuses under NODE_ENV=production — there is no legitimate
//      reason to ever run this against a production database.
//   2. Requires an explicit --yes flag even in development, so a casually
//      typed `npm run reset` can't wipe a dev database by accident.
if (process.env.NODE_ENV === 'production') {
  console.error('REFUSED: reset-database.js drops the entire database and must never run with NODE_ENV=production.');
  process.exit(1);
}
if (!process.argv.includes('--yes')) {
  console.error(`REFUSED: this drops and recreates the '${process.env.DB_NAME || 'ezone'}' database, destroying ALL data.`);
  console.error('If you really mean it, re-run with the explicit flag:\n');
  console.error('  node reset-database.js --yes\n');
  process.exit(1);
}

const resetDatabase = async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });

  try {
    console.log('Dropping database...');
    await connection.execute(`DROP DATABASE IF EXISTS ${process.env.DB_NAME || 'ezone'}`);
    console.log('Database dropped');

    console.log('Creating database...');
    await connection.execute(`CREATE DATABASE ${process.env.DB_NAME || 'ezone'}`);
    console.log('Database created');

    await connection.end();

    // Delegate schema creation + every migration + mock-data loading to the
    // same initializeDatabase the app's normal boot path uses. This file
    // used to hand-duplicate its own copy of the schema, which drifted out
    // of sync with every migration added to config/database.js — there is
    // now only ever one place the schema is defined.
    console.log('\nInitializing schema and loading mock data...');
    const { initializeDatabase } = require('./config/database');
    await initializeDatabase(true);

    console.log('Database reset complete');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
};

resetDatabase();
