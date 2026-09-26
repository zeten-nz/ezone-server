const { pool } = require('../config/database');
const repository = require('../repositories/clientWarrantyExportRepository');
const { createClientWarrantyWorkbook, appendClientWarranty } = require('../utils/clientWarrantyWorkbook');

async function exportClientWarranty(req, res, next) {
  let connection;
  try {
    const filters = {
      employeeId: req.query.employeeId ? parseInt(req.query.employeeId, 10) : undefined,
      search: (req.query.search || '').trim() || undefined,
      verificationStatus: req.query.verificationStatus || undefined,
    };
    const workbook = createClientWarrantyWorkbook();
    connection = await pool.getConnection();
    let lastId = 0;
    while (true) {
      const forms = await repository.findChunk(connection, { ...filters, lastId, limit: 500 });
      if (!forms.length) break;
      for (const form of forms) appendClientWarranty(workbook.worksheets[0], form);
      lastId = forms[forms.length - 1].id;
    }
    connection.release();
    connection = null;
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="client_warranty_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
}

module.exports = { exportClientWarranty };
