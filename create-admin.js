require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./config/database');

const createAdminUser = async () => {
  const fullName = process.argv[2] || 'Administrator';
  const username = process.argv[3] || 'admin';
  const password = process.argv[4] || 'admin123';

  if (password.length < 6) {
    console.error('Error: Password must be at least 6 characters');
    process.exit(1);
  }

  try {
    const connection = await pool.getConnection();

    const [existing] = await connection.execute(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );

    if (existing.length > 0) {
      console.error(`Error: Username '${username}' already exists`);
      connection.release();
      process.exit(1);
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await connection.execute(
      `INSERT INTO users (full_name, username, password, role, is_active, branch_code, phone)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [fullName, username, hashedPassword, 'ADMIN', true, 'ADMIN', null]
    );

    connection.release();

    console.log('\n✓ Admin user created successfully!\n');
    console.log('Login credentials:');
    console.log(`  Username: ${username}`);
    console.log(`  Password: ${password}\n`);
    console.log('IMPORTANT: Change the password after first login!\n');

    process.exit(0);
  } catch (error) {
    console.error('Error creating admin user:', error.message);
    process.exit(1);
  }
};

createAdminUser();
