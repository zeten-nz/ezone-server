const ExcelJS = require('exceljs');
const { pool } = require('../config/database');

const getDateRangeFilter = (days) => {
  if (!days || days === 'all') return null;
  const date = new Date();
  date.setDate(date.getDate() - parseInt(days));
  return date.toISOString().split('T')[0];
};

// Excel exports are binary file streams, not JSON — they can't go through the
// same errorCode/translations mechanism as the rest of the API. This is the
// one place the backend needs to know the caller's language, passed as a
// plain query param (the calling page already has it via useLanguage()).
const getLang = (req) => (req.query.lang === 'ru' ? 'ru' : 'uz');

// Single bilingual source for every column label used across all 3 export
// functions — replaces what used to be 3 separate hardcoded English arrays.
const EXCEL_FIELD_LABELS = {
  id:             { uz: 'ID',                 ru: 'ID' },
  employee:       { uz: 'Xodim',              ru: 'Сотрудник' },
  region:         { uz: 'Viloyat',            ru: 'Область' },
  city:           { uz: 'Shahar',             ru: 'Город' },
  district:       { uz: 'Tuman',              ru: 'Район' },
  organization:   { uz: 'Tashkilot',          ru: 'Организация' },
  orgPhone:       { uz: 'Telefon',            ru: 'Телефон' },
  installer:      { uz: "O'rnatuvchi",        ru: 'Установщик' },
  warrantyNumber: { uz: 'Kafolat №',          ru: 'Гарантия №' },
  date:           { uz: 'Sana',               ru: 'Дата' },
  brand:          { uz: 'Brend',              ru: 'Марка' },
  model:          { uz: 'Model',              ru: 'Модель' },
  year:           { uz: 'Yil',                ru: 'Год' },
  plate:          { uz: 'Raqam',              ru: 'Номер' },
  vin:            { uz: 'VIN',                ru: 'VIN' },
  engineVol:      { uz: 'Dvigatel hajmi',     ru: 'Объем двиг.' },
  power:          { uz: 'Quvvat',             ru: 'Мощность' },
  mileage:        { uz: 'Probeg',             ru: 'Пробег' },
  owner:          { uz: 'Egasi',              ru: 'Владелец' },
  ownerPhone:     { uz: 'Telefon',            ru: 'Телефон' },
  reducerType:    { uz: 'Redyuktor turi',     ru: 'Тип редуктора' },
  reducer:        { uz: 'Redyuktor',          ru: 'Редуктор' },
  reducerSerial:  { uz: 'Seriya',             ru: 'Серия' },
  cylinderType:   { uz: 'Tsilindr turi',      ru: 'Тип цилиндра' },
  cylinder:       { uz: 'Tsilindr',           ru: 'Цилиндр' },
  cylinderSerial: { uz: 'Seriya',             ru: 'Серия' },
  stag:           { uz: 'STAG',               ru: 'STAG' },
  stagSerial:     { uz: 'Seriya',             ru: 'Серия' },
  injector:       { uz: 'Injektor',           ru: 'Инжектор' },
  injectorSerial: { uz: 'Seriya',             ru: 'Серия' },
  branch:         { uz: 'Filial',             ru: 'Филиал' },
};

const buildHeaders = (keys, lang) => keys.map((key) => EXCEL_FIELD_LABELS[key][lang]);

const exportWarrantyForms = async (req, res, next) => {
  try {
    const { days } = req.query;
    const lang = getLang(req);
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
    const worksheet = workbook.addWorksheet(lang === 'ru' ? 'Гарантийные формы' : 'Kafolat daftarlari');

    const columnKeys = [
      'id', 'employee', 'region', 'city', 'district', 'organization', 'orgPhone',
      'installer', 'warrantyNumber', 'date', 'brand', 'model', 'year',
      'plate', 'vin', 'engineVol', 'power', 'mileage', 'owner', 'ownerPhone',
      'reducerType', 'reducer', 'reducerSerial', 'cylinderType', 'cylinder',
      'cylinderSerial', 'stag', 'stagSerial', 'injector', 'injectorSerial', 'branch',
    ];

    const headerRow = worksheet.addRow(buildHeaders(columnKeys, lang));
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a8a' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };

    // Set column widths
    const columnWidths = [8, 14, 10, 10, 10, 14, 10, 12, 12, 12, 12, 12, 8, 11, 11, 11, 10, 10, 12, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 12];
    worksheet.columns = columnWidths.map(width => ({ width }));

    const dateLocale = lang === 'ru' ? 'ru-RU' : 'uz-UZ';

    // Add data rows
    forms.forEach((form, idx) => {
      const row = worksheet.addRow([
        form.id, form.employee_name, form.region, form.city, form.district,
        form.organization_name, form.organization_phone, form.installer_full_name,
        form.warranty_book_number, new Date(form.installation_date).toLocaleDateString(dateLocale),
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
    console.error('Export warranty forms error:', error);
    if (!res.headersSent) {
      next(error);
    } else {
      res.end();
    }
  }
};

const exportByBranch = async (req, res, next) => {
  try {
    const { branch, days } = req.query;
    const lang = getLang(req);
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
    const titleRow = worksheet.addRow([`${lang === 'ru' ? 'Филиал' : 'Filial'}: ${branch}`]);
    titleRow.font = { bold: true, size: 12, color: { argb: 'FF1e3a8a' } };
    worksheet.addRow([]);

    const columnKeys = [
      'id', 'employee', 'region', 'city', 'district', 'organization', 'orgPhone',
      'installer', 'warrantyNumber', 'date', 'brand', 'model', 'year',
      'plate', 'vin', 'engineVol', 'power', 'mileage', 'owner', 'ownerPhone',
      'reducerType', 'reducer', 'reducerSerial', 'cylinderType', 'cylinder',
      'cylinderSerial', 'stag', 'stagSerial', 'injector', 'injectorSerial',
    ];

    const headerRow = worksheet.addRow(buildHeaders(columnKeys, lang));
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a8a' } };

    const columnWidths = [8, 14, 10, 10, 10, 14, 10, 12, 12, 12, 12, 12, 8, 11, 11, 11, 10, 10, 12, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    worksheet.columns = columnWidths.map(width => ({ width }));

    const dateLocale = lang === 'ru' ? 'ru-RU' : 'uz-UZ';

    // Add data rows
    forms.forEach((form, idx) => {
      const row = worksheet.addRow([
        form.id, form.employee_name, form.region, form.city, form.district,
        form.organization_name, form.organization_phone, form.installer_full_name,
        form.warranty_book_number, new Date(form.installation_date).toLocaleDateString(dateLocale),
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
    console.error('Export by branch error:', error);
    if (!res.headersSent) {
      next(error);
    } else {
      res.end();
    }
  }
};

const exportEmployeeData = async (req, res, next) => {
  try {
    const { employeeId, days } = req.query;
    const lang = getLang(req);
    const dateFilter = getDateRangeFilter(days);

    const connection = await pool.getConnection();

    const [empData] = await connection.execute(
      'SELECT full_name, username, branch_code FROM users WHERE id = ?',
      [employeeId]
    );

    if (empData.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Employee not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
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

    const columnKeys = [
      'id', 'region', 'city', 'district', 'organization', 'orgPhone',
      'installer', 'warrantyNumber', 'date', 'brand', 'model', 'year',
      'plate', 'vin', 'engineVol', 'power', 'mileage', 'owner', 'ownerPhone',
      'reducerType', 'reducer', 'reducerSerial', 'cylinderType', 'cylinder',
      'cylinderSerial', 'stag', 'stagSerial', 'injector', 'injectorSerial',
    ];

    const headerRow = worksheet.addRow(buildHeaders(columnKeys, lang));
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a8a' } };

    const columnWidths = [8, 10, 10, 10, 14, 10, 12, 12, 12, 12, 12, 8, 11, 11, 11, 10, 10, 12, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    worksheet.columns = columnWidths.map(width => ({ width }));

    const dateLocale = lang === 'ru' ? 'ru-RU' : 'uz-UZ';

    // Add data rows
    forms.forEach((form, idx) => {
      const row = worksheet.addRow([
        form.id, form.region, form.city, form.district,
        form.organization_name, form.organization_phone, form.installer_full_name,
        form.warranty_book_number, new Date(form.installation_date).toLocaleDateString(dateLocale),
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
    console.error('Export employee data error:', error);
    if (!res.headersSent) {
      next(error);
    } else {
      res.end();
    }
  }
};

module.exports = { exportWarrantyForms, exportByBranch, exportEmployeeData };
