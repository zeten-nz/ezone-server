require('dotenv').config();
const mysql = require('mysql2/promise');
const { generateMockData } = require('./config/mockData');

const resetDatabase = async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });

  try {
    console.log('Dropping database...');
    await connection.execute(`DROP DATABASE IF EXISTS ${process.env.DB_NAME || 'stag_warranty'}`);
    console.log('Database dropped');

    console.log('Creating database...');
    await connection.execute(`CREATE DATABASE ${process.env.DB_NAME || 'stag_warranty'}`);
    console.log('Database created');

    await connection.end();

    // Now create tables and load mock data
    console.log('\nCreating tables and loading mock data...');
    const { pool } = require('./config/database');
    const conn = await pool.getConnection();

    // Create users table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT PRIMARY KEY AUTO_INCREMENT,
        full_name VARCHAR(255) NOT NULL,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        phone VARCHAR(20),
        branch_code VARCHAR(100),
        role ENUM('ADMIN', 'EMPLOYEE') DEFAULT 'EMPLOYEE',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Create warranty_forms table
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS warranty_forms (
        id INT PRIMARY KEY AUTO_INCREMENT,
        employee_id INT NOT NULL,
        region VARCHAR(100) NOT NULL,
        city VARCHAR(100) NOT NULL,
        district VARCHAR(100) NOT NULL,
        organization_name VARCHAR(255) NOT NULL,
        organization_phone VARCHAR(20) NOT NULL,
        installer_full_name VARCHAR(255) NOT NULL,
        warranty_book_number VARCHAR(100) NOT NULL,
        installation_date DATE NOT NULL,
        vehicle_brand VARCHAR(100) NOT NULL,
        vehicle_model VARCHAR(100) NOT NULL,
        vehicle_production_year INT NOT NULL,
        vehicle_plate_number VARCHAR(50) NOT NULL,
        vehicle_vin VARCHAR(100) NOT NULL,
        vehicle_engine_volume VARCHAR(50) NOT NULL,
        vehicle_engine_power VARCHAR(50) NOT NULL,
        vehicle_mileage INT NOT NULL,
        owner_full_name VARCHAR(255) NOT NULL,
        owner_phone VARCHAR(20) NOT NULL,
        reducer_fuel_type ENUM('LPG', 'CNG') NOT NULL,
        reducer_manufacturer VARCHAR(100) NOT NULL,
        reducer_serial_number VARCHAR(100) NOT NULL,
        cylinder_fuel_type ENUM('LPG', 'CNG') NOT NULL,
        cylinder_manufacturer VARCHAR(100) NOT NULL,
        cylinder_serial_number VARCHAR(100) NOT NULL,
        stag_controller_manufacturer VARCHAR(100) NOT NULL,
        stag_controller_serial_number VARCHAR(100) NOT NULL,
        injector_rail_manufacturer VARCHAR(100) NOT NULL,
        injector_rail_serial_number VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES users(id)
      )
    `);

    console.log('Tables created successfully');

    // Load mock data
    console.log('Loading mock data...');
    await generateMockData(conn);

    conn.release();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
};

resetDatabase();
