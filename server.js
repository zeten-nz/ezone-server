require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initializeDatabase } = require('./config/database');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const warrantyRoutes = require('./routes/warrantyRoutes');
const { exportWarrantyForms, exportByBranch, exportEmployeeData } = require('./controllers/excelController');
const { verifyToken, authorizeRole } = require('./middleware/auth');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/warranty', warrantyRoutes);
app.get('/api/export/warranty', verifyToken, authorizeRole('ADMIN'), exportWarrantyForms);
app.get('/api/export/branch', verifyToken, authorizeRole('ADMIN'), exportByBranch);
app.get('/api/export/employee', verifyToken, exportEmployeeData);

app.get('/api/dashboard', verifyToken, authorizeRole('ADMIN'), async (req, res) => {
  try {
    const { pool } = require('./config/database');
    const connection = await pool.getConnection();

    const [employeeCount] = await connection.execute(
      'SELECT COUNT(*) as count FROM users WHERE role = ? AND is_active = ?',
      ['EMPLOYEE', true]
    );

    const [formCount] = await connection.execute(
      'SELECT COUNT(*) as count FROM warranty_forms'
    );

    const [recentForms] = await connection.execute(
      `SELECT wf.*, u.full_name as employee_name
       FROM warranty_forms wf
       JOIN users u ON wf.employee_id = u.id
       ORDER BY wf.created_at DESC
       LIMIT 5`
    );

    connection.release();

    res.json({
      total_employees: employeeCount[0].count,
      total_forms: formCount[0].count,
      recent_forms: recentForms
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    const loadMockData = process.env.LOAD_MOCK_DATA !== 'false';
    await initializeDatabase(loadMockData);
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
