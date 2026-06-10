const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'stag_warranty',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const initializeDatabase = async (loadMockData = false) => {
  try {
    const connection = await pool.getConnection();
    console.log('Database connected successfully');

    // Create users table
    await connection.execute(`
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
    await connection.execute(`
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

    // Check if data already exists and load mock data if needed
    const [existingUsers] = await connection.execute('SELECT COUNT(*) as count FROM users');
    const hasData = existingUsers[0].count > 0;

    if (loadMockData && !hasData) {
      console.log('Loading mock data...');
      const { generateMockData } = require('./mockData');
      await generateMockData(connection);
    }

    connection.release();
  } catch (error) {
    console.error('Database initialization error:', error);
    process.exit(1);
  }
};

module.exports = { pool, initializeDatabase };
