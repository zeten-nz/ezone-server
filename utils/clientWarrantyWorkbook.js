const ExcelJS = require('exceljs');
const layout = require('../config/clientWarrantyLayout.json');
const { mapClientWarranty } = require('./clientWarrantyExcelMapper');
const border = Object.fromEntries(['top', 'bottom', 'left', 'right'].map((side) => [side, { style: 'thin', color: { argb: 'FF000000' } }]));

function createClientWarrantyWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Kafolat', { views: [{ state: 'frozen', ySplit: 3 }] });
  sheet.columns = layout.widths.map((width) => ({ width }));
  sheet.getCell('B1').value = 'Kafolat reyestri';
  sheet.getCell('B1').font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FF1E3A8A' } };
  sheet.getRow(1).height = 20;
  [layout.ru, layout.uz].forEach((headers, index) => {
    const row = sheet.getRow(index + 2);
    row.values = headers;
    row.height = 45;
    row.eachCell((cell) => {
      cell.font = { name: 'Calibri', size: 10, bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { theme: index ? 6 : 9, tint: 0.5999938962981048 } };
      cell.border = border;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
  });
  return workbook;
}

function appendClientWarranty(sheet, form) {
  const mapped = mapClientWarranty(form);
  for (const [column, value] of Object.entries(mapped)) {
    if (typeof value === 'string' && value.length > 32767) {
      const error = new Error(`Warranty ${form.id || ''}, column ${column} exceeds Excel's 32,767-character cell limit. Use the CSV export to preserve the full value.`);
      error.statusCode = 422;
      throw error;
    }
  }
  // Strings are literal shared strings in XLSX, including =,+,-,@. Never formula objects.
  const row = sheet.addRow(Object.values(mapped).map((value) => value === '' ? null : value));
  row.eachCell({ includeEmpty: true }, (cell, index) => {
    cell.numFmt = index === 10 ? 'dd/mm/yyyy' : '@';
    cell.font = { name: 'Calibri', size: 10 };
    cell.border = border;
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  row.height = Math.min(409, Math.max(30, ...[24, 28, 31, 34].map((col) => Math.ceil(String(row.getCell(col).value || '').length / (layout.widths[col - 1] - 2)) * 15)));
  return row;
}

module.exports = { createClientWarrantyWorkbook, appendClientWarranty };
