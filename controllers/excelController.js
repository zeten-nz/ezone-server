const ExcelJS = require('exceljs');
const { pool } = require('../config/database');
const { attachEquipment } = require('../utils/warrantyEquipment');
const { resolveVehicleName } = require('../utils/vehicleName');

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
// functions.
const EXCEL_FIELD_LABELS = {
  id:                { uz: 'ID',                       ru: 'ID' },
  employee:          { uz: 'Xodim',                    ru: 'Сотрудник' },
  region:            { uz: 'Viloyat',                  ru: 'Область' },
  city:              { uz: 'Shahar',                   ru: 'Город' },
  district:          { uz: 'Tuman',                    ru: 'Район' },
  organization:      { uz: 'Tashkilot',                ru: 'Организация' },
  orgPhone:          { uz: 'Telefon',                  ru: 'Телефон' },
  installer:         { uz: "O'rnatuvchi",              ru: 'Установщик' },
  warrantyNumber:    { uz: 'Kafolat №',                ru: 'Гарантия №' },
  date:              { uz: 'Sana',                     ru: 'Дата' },
  vehicle:           { uz: 'Avtomobil',                ru: 'Автомобиль' },
  year:              { uz: 'Yil',                      ru: 'Год' },
  plate:             { uz: 'Raqam',                    ru: 'Номер' },
  vin:               { uz: 'VIN',                      ru: 'VIN' },
  engineVol:         { uz: 'Dvigatel hajmi',           ru: 'Объем двиг.' },
  power:             { uz: 'Quvvat',                   ru: 'Мощность' },
  mileage:           { uz: 'Probeg',                   ru: 'Пробег' },
  owner:             { uz: 'Egasi',                    ru: 'Владелец' },
  ownerPhone:        { uz: 'Telefon',                  ru: 'Телефон' },
  installedProducts: { uz: "O'rnatilgan jihozlar",     ru: 'Установленное оборудование' },
  branch:            { uz: 'Filial',                   ru: 'Филиал' },
};

const EQUIPMENT_TYPE_LABELS = {
  REDUCER:       { uz: 'Redyuktor',       ru: 'Редуктор' },
  CYLINDER:      { uz: 'Tsilindr',        ru: 'Цилиндр' },
  CONTROLLER:    { uz: 'Kontroller',      ru: 'Контроллер' },
  INJECTOR_RAIL: { uz: 'Injektor relsi',  ru: 'Инжекторная рейка' },
};

const buildHeaders = (keys, lang) => keys.map((key) => EXCEL_FIELD_LABELS[key][lang]);

/**
 * One column summarizing every equipment row — falls back to the original 4
 * legacy free-text fields for historical rows recorded before either the
 * product-catalog or equipment-normalization redesigns existed (see
 * utils/warrantyEquipment.js).
 */
const formatEquipmentSummary = (form, lang) => {
  if (form.equipment && form.equipment.length > 0) {
    return form.equipment
      .map((e) => {
        const label = EQUIPMENT_TYPE_LABELS[e.equipment_type]?.[lang] || e.equipment_type;
        return `${label}: ${e.product_name}${e.serial_number ? ` (${e.serial_number})` : ''}`;
      })
      .join('; ');
  }

  const parts = [];
  if (form.reducer_manufacturer) parts.push(`${lang === 'ru' ? 'Редуктор' : 'Redyuktor'}: ${form.reducer_manufacturer} (${form.reducer_serial_number})`);
  if (form.cylinder_manufacturer) parts.push(`${lang === 'ru' ? 'Цилиндр' : 'Tsilindr'}: ${form.cylinder_manufacturer} (${form.cylinder_serial_number})`);
  if (form.stag_controller_manufacturer) parts.push(`STAG: ${form.stag_controller_manufacturer} (${form.stag_controller_serial_number})`);
  if (form.injector_rail_manufacturer) parts.push(`${lang === 'ru' ? 'Инжектор' : 'Injektor'}: ${form.injector_rail_manufacturer} (${form.injector_rail_serial_number})`);
  return parts.join('; ') || '—';
};

const exportWarrantyForms = async (req, res, next) => {
  try {
    const { days } = req.query;
    const lang = getLang(req);
    const dateFilter = getDateRangeFilter(days);

    let query = `SELECT wf.*, u.full_name as employee_name, u.branch_code
       FROM warranty_forms wf
       JOIN users u ON wf.employee_id = u.id`;

    const params = [];

    if (dateFilter) {
      query += ` WHERE DATE(wf.created_at) >= ?`;
      params.push(dateFilter);
    }

    query += ` ORDER BY wf.created_at DESC`;

    // Inner try/finally so a query failure can't leak the connection, while
    // keeping the original release timing — returned to the pool BEFORE the
    // (potentially slow) workbook build/stream below, which never touches
    // the DB. Errors still reach the outer catch unchanged.
    let forms;
    const connection = await pool.getConnection();
    try {
      const [rawForms] = await connection.execute(query, params);
      forms = await attachEquipment(connection, rawForms);
    } finally {
      connection.release();
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(lang === 'ru' ? 'Гарантийные формы' : 'Kafolat daftarlari');

    const columnKeys = [
      'id', 'employee', 'region', 'city', 'district', 'organization', 'orgPhone',
      'installer', 'warrantyNumber', 'date', 'vehicle', 'year',
      'plate', 'vin', 'engineVol', 'power', 'mileage', 'owner', 'ownerPhone',
      'installedProducts', 'branch',
    ];

    const headerRow = worksheet.addRow(buildHeaders(columnKeys, lang));
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a8a' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };

    // Set column widths
    const columnWidths = [8, 14, 10, 10, 10, 14, 10, 12, 12, 12, 20, 8, 11, 11, 11, 10, 10, 12, 10, 40, 12];
    worksheet.columns = columnWidths.map(width => ({ width }));

    const dateLocale = lang === 'ru' ? 'ru-RU' : 'uz-UZ';

    // Add data rows
    forms.forEach((form, idx) => {
      const row = worksheet.addRow([
        form.id, form.employee_name, form.installer_region, form.city, form.installer_district,
        form.installer_branch, form.organization_phone, form.installer_full_name,
        form.warranty_book_number, new Date(form.installation_date).toLocaleDateString(dateLocale),
        resolveVehicleName(form), form.vehicle_production_year,
        form.vehicle_plate_number, form.vehicle_vin, form.vehicle_engine_volume,
        form.vehicle_engine_power, form.vehicle_mileage, form.owner_full_name,
        form.owner_phone, formatEquipmentSummary(form, lang), form.branch_code
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

    // Same leak-proof inner try/finally as exportWarrantyForms above.
    let forms;
    const connection = await pool.getConnection();
    try {
      const [rawForms] = await connection.execute(query, params);
      forms = await attachEquipment(connection, rawForms);
    } finally {
      connection.release();
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(branch.substring(0, 31));

    // Title
    const titleRow = worksheet.addRow([`${lang === 'ru' ? 'Филиал' : 'Filial'}: ${branch}`]);
    titleRow.font = { bold: true, size: 12, color: { argb: 'FF1e3a8a' } };
    worksheet.addRow([]);

    const columnKeys = [
      'id', 'employee', 'region', 'city', 'district', 'organization', 'orgPhone',
      'installer', 'warrantyNumber', 'date', 'vehicle', 'year',
      'plate', 'vin', 'engineVol', 'power', 'mileage', 'owner', 'ownerPhone',
      'installedProducts',
    ];

    const headerRow = worksheet.addRow(buildHeaders(columnKeys, lang));
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a8a' } };

    const columnWidths = [8, 14, 10, 10, 10, 14, 10, 12, 12, 12, 20, 8, 11, 11, 11, 10, 10, 12, 10, 40];
    worksheet.columns = columnWidths.map(width => ({ width }));

    const dateLocale = lang === 'ru' ? 'ru-RU' : 'uz-UZ';

    // Add data rows
    forms.forEach((form, idx) => {
      const row = worksheet.addRow([
        form.id, form.employee_name, form.installer_region, form.city, form.installer_district,
        form.installer_branch, form.organization_phone, form.installer_full_name,
        form.warranty_book_number, new Date(form.installation_date).toLocaleDateString(dateLocale),
        resolveVehicleName(form), form.vehicle_production_year,
        form.vehicle_plate_number, form.vehicle_vin, form.vehicle_engine_volume,
        form.vehicle_engine_power, form.vehicle_mileage, form.owner_full_name,
        form.owner_phone, formatEquipmentSummary(form, lang)
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

    // Same leak-proof inner try/finally as exportWarrantyForms above — the
    // employee-not-found early return moves after the release (it needs
    // empData, not the connection), preserving its exact 404 response.
    let empData;
    let forms;
    const connection = await pool.getConnection();
    try {
      [empData] = await connection.execute(
        'SELECT full_name, username, branch_code FROM users WHERE id = ?',
        [employeeId]
      );

      if (empData.length > 0) {
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

        const [rawForms] = await connection.execute(query, params);
        forms = await attachEquipment(connection, rawForms);
      }
    } finally {
      connection.release();
    }

    if (empData.length === 0) {
      return res.status(404).json({ success: false, message: 'Employee not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(empData[0].full_name.substring(0, 31));

    // Title
    const titleRow = worksheet.addRow([empData[0].full_name]);
    titleRow.font = { bold: true, size: 12, color: { argb: 'FF1e3a8a' } };
    worksheet.addRow([]);

    const columnKeys = [
      'id', 'region', 'city', 'district', 'organization', 'orgPhone',
      'installer', 'warrantyNumber', 'date', 'vehicle', 'year',
      'plate', 'vin', 'engineVol', 'power', 'mileage', 'owner', 'ownerPhone',
      'installedProducts',
    ];

    const headerRow = worksheet.addRow(buildHeaders(columnKeys, lang));
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e3a8a' } };

    const columnWidths = [8, 10, 10, 10, 14, 10, 12, 12, 12, 20, 8, 11, 11, 11, 10, 10, 12, 10, 40];
    worksheet.columns = columnWidths.map(width => ({ width }));

    const dateLocale = lang === 'ru' ? 'ru-RU' : 'uz-UZ';

    // Add data rows
    forms.forEach((form, idx) => {
      const row = worksheet.addRow([
        form.id, form.installer_region, form.city, form.installer_district,
        form.installer_branch, form.organization_phone, form.installer_full_name,
        form.warranty_book_number, new Date(form.installation_date).toLocaleDateString(dateLocale),
        resolveVehicleName(form), form.vehicle_production_year,
        form.vehicle_plate_number, form.vehicle_vin, form.vehicle_engine_volume,
        form.vehicle_engine_power, form.vehicle_mileage, form.owner_full_name,
        form.owner_phone, formatEquipmentSummary(form, lang)
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
