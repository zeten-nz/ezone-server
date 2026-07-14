require('dotenv').config();
const mysql = require('mysql2/promise');

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
