const ExcelJS = require('exceljs');
const { pool } = require('../config/database');

const getDateRangeFilter = (days) => {
  if (!days || days === 'all') return null;
  const date = new Date();
  date.setDate(date.getDate() - parseInt(days));
  return date.toISOString().split('T')[0];
};

const exportWarrantyForms = async (req, res) => {
  try {
    const { days } = req.query;
    const dateFilter = getDateRangeFilter(days);

    const connection = await pool.getConnection();

    let query = `SELECT wf.*, u.full_name as employee_name, u.branch_code
       FROM warranty_forms wf
       JOIN users u ON wf.employee_id = u.id`;

    const params = [];

    if (dateFilter) {
      query += ` WHERE DATE(wf.created_at) >= ?`;
      params.push(dateFilter);
    }

    query += ` ORDER BY wf.created_at DESC`;

    const [forms] = await connection.execute(query, params);
    connection.release();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Warranty Forms');

    // Headers
    const headers = [
      'ID', 'Employee', 'Region', 'City', 'District', 'Organization', 'Phone',
      'Installer', 'Warranty #', 'Date', 'Brand', 'Model', 'Year',
      'Plate', 'VIN', 'Engine Vol', 'Power', 'Mileage', 'Owner', 'Phone',
      'Reducer Type', 'Reducer', 'Serial', 'Cylinder Type', 'Cylinder',
      'Serial', 'STAG', 'Serial', 'Injector', 'Serial', 'Branch'
    ];

    const headerRow = worksheet.addRow(headers);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a8a' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };

    // Set column widths
    const columnWidths = [8, 14, 10, 10, 10, 14, 10, 12, 12, 12, 12, 12, 8, 11, 11, 11, 10, 10, 12, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 12];
    worksheet.columns = columnWidths.map(width => ({ width }));

    // Add data rows
    forms.forEach((form, idx) => {
      const row = worksheet.addRow([
        form.id, form.employee_name, form.region, form.city, form.district,
        form.organization_name, form.organization_phone, form.installer_full_name,
        form.warranty_book_number, new Date(form.installation_date).toLocaleDateString('uz-UZ'),
        form.vehicle_brand, form.vehicle_model, form.vehicle_production_year,
        form.vehicle_plate_number, form.vehicle_vin, form.vehicle_engine_volume,
        form.vehicle_engine_power, form.vehicle_mileage, form.owner_full_name,
        form.owner_phone, form.reducer_fuel_type, form.reducer_manufacturer,
        form.reducer_serial_number, form.cylinder_fuel_type, form.cylinder_manufacturer,
        form.cylinder_serial_number, form.stag_controller_manufacturer,
        form.stag_controller_serial_number, form.injector_rail_manufacturer,
        form.injector_rail_serial_number, form.branch_code
      ]);

      row.font = { size: 9 };
      row.alignment = { horizontal: 'left', vertical: 'center', wrapText: true };
      row.height = 20;

      if (idx % 2 === 0) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      }
    });

    worksheet.views = [{ state: 'frozen', ySplit: 1 }];

    const timeRange = days ? `_last${days}days` : '_all';
    const filename = `warranty_${new Date().toISOString().split('T')[0]}${timeRange}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ message: 'Export error: ' + error.message });
  }
};

const exportByBranch = async (req, res) => {
  try {
    const { branch, days } = req.query;
    const dateFilter = getDateRangeFilter(days);

    const connection = await pool.getConnection();

    let query = `SELECT wf.*, u.full_name as employee_name, u.branch_code
       FROM warranty_forms wf
       JOIN users u ON wf.employee_id = u.id
       WHERE u.branch_code = ?`;

    const params = [branch];

    if (dateFilter) {
      query += ` AND DATE(wf.created_at) >= ?`;
      params.push(dateFilter);
    }

    query += ` ORDER BY wf.created_at DESC`;

    const [forms] = await connection.execute(query, params);
    connection.release();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(branch.substring(0, 31));

    // Title
    const titleRow = worksheet.addRow([`Branch: ${branch}`]);
    titleRow.font = { bold: true, size: 12, color: { argb: 'FF1e3a8a' } };
    worksheet.addRow([]);

    // Headers
    const headers = [
      'ID', 'Employee', 'Region', 'City', 'District', 'Organization', 'Phone',
      'Installer', 'Warranty #', 'Date', 'Brand', 'Model', 'Year',
      'Plate', 'VIN', 'Engine Vol', 'Power', 'Mileage', 'Owner', 'Phone',
      'Reducer Type', 'Reducer', 'Serial', 'Cylinder Type', 'Cylinder',
      'Serial', 'STAG', 'Serial', 'Injector', 'Serial'
    ];

    const headerRow = worksheet.addRow(headers);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a8a' } };

    const columnWidths = [8, 14, 10, 10, 10, 14, 10, 12, 12, 12, 12, 12, 8, 11, 11, 11, 10, 10, 12, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    worksheet.columns = columnWidths.map(width => ({ width }));

    // Add data rows
    forms.forEach((form, idx) => {
      const row = worksheet.addRow([
        form.id, form.employee_name, form.region, form.city, form.district,
        form.organization_name, form.organization_phone, form.installer_full_name,
        form.warranty_book_number, new Date(form.installation_date).toLocaleDateString('uz-UZ'),
        form.vehicle_brand, form.vehicle_model, form.vehicle_production_year,
        form.vehicle_plate_number, form.vehicle_vin, form.vehicle_engine_volume,
        form.vehicle_engine_power, form.vehicle_mileage, form.owner_full_name,
        form.owner_phone, form.reducer_fuel_type, form.reducer_manufacturer,
        form.reducer_serial_number, form.cylinder_fuel_type, form.cylinder_manufacturer,
        form.cylinder_serial_number, form.stag_controller_manufacturer,
        form.stag_controller_serial_number, form.injector_rail_manufacturer,
        form.injector_rail_serial_number
      ]);

      row.font = { size: 9 };
      row.alignment = { horizontal: 'left', vertical: 'center', wrapText: true };
      row.height = 20;

      if (idx % 2 === 0) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      }
    });

    worksheet.views = [{ state: 'frozen', ySplit: 3 }];

    const timeRange = days ? `_last${days}days` : '_all';
    const filename = `${branch}_${new Date().toISOString().split('T')[0]}${timeRange}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ message: 'Export error: ' + error.message });
  }
};

const exportEmployeeData = async (req, res) => {
  try {
    const { employeeId, days } = req.query;
    const dateFilter = getDateRangeFilter(days);

    const connection = await pool.getConnection();

    const [empData] = await connection.execute(
      'SELECT full_name, username, branch_code FROM users WHERE id = ?',
      [employeeId]
    );

    if (empData.length === 0) {
      connection.release();
      return res.status(404).json({ message: 'Employee not found' });
    }

    let query = `SELECT wf.*, u.full_name as employee_name
       FROM warranty_forms wf
       JOIN users u ON wf.employee_id = u.id
       WHERE wf.employee_id = ?`;

    const params = [employeeId];

    if (dateFilter) {
      query += ` AND DATE(wf.created_at) >= ?`;
      params.push(dateFilter);
    }

    query += ` ORDER BY wf.created_at DESC`;

    const [forms] = await connection.execute(query, params);
    connection.release();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(empData[0].full_name.substring(0, 31));

    // Title
    const titleRow = worksheet.addRow([empData[0].full_name]);
    titleRow.font = { bold: true, size: 12, color: { argb: 'FF1e3a8a' } };
    worksheet.addRow([]);

    // Headers
    const headers = [
      'ID', 'Region', 'City', 'District', 'Organization', 'Phone',
      'Installer', 'Warranty #', 'Date', 'Brand', 'Model', 'Year',
      'Plate', 'VIN', 'Engine Vol', 'Power', 'Mileage', 'Owner', 'Phone',
      'Reducer Type', 'Reducer', 'Serial', 'Cylinder Type', 'Cylinder',
      'Serial', 'STAG', 'Serial', 'Injector', 'Serial'
    ];

    const headerRow = worksheet.addRow(headers);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a8a' } };

    const columnWidths = [8, 10, 10, 10, 14, 10, 12, 12, 12, 12, 12, 8, 11, 11, 11, 10, 10, 12, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    worksheet.columns = columnWidths.map(width => ({ width }));

    // Add data rows
    forms.forEach((form, idx) => {
      const row = worksheet.addRow([
        form.id, form.region, form.city, form.district,
        form.organization_name, form.organization_phone, form.installer_full_name,
        form.warranty_book_number, new Date(form.installation_date).toLocaleDateString('uz-UZ'),
        form.vehicle_brand, form.vehicle_model, form.vehicle_production_year,
        form.vehicle_plate_number, form.vehicle_vin, form.vehicle_engine_volume,
        form.vehicle_engine_power, form.vehicle_mileage, form.owner_full_name,
        form.owner_phone, form.reducer_fuel_type, form.reducer_manufacturer,
        form.reducer_serial_number, form.cylinder_fuel_type, form.cylinder_manufacturer,
        form.cylinder_serial_number, form.stag_controller_manufacturer,
        form.stag_controller_serial_number, form.injector_rail_manufacturer,
        form.injector_rail_serial_number
      ]);

      row.font = { size: 9 };
      row.alignment = { horizontal: 'left', vertical: 'center', wrapText: true };
      row.height = 20;

      if (idx % 2 === 0) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      }
    });

    worksheet.views = [{ state: 'frozen', ySplit: 3 }];

    const timeRange = days ? `_last${days}days` : '_all';
    const filename = `${empData[0].username}_${new Date().toISOString().split('T')[0]}${timeRange}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ message: 'Export error: ' + error.message });
  }
};

module.exports = { exportWarrantyForms, exportByBranch, exportEmployeeData };
