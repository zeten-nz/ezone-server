const AppError = require('./AppError');
const { EQUIPMENT_SERIAL_RULES, SERIAL_MAX_LENGTH, SERIAL_STORAGE_MAX_BYTES } = require('../config/equipmentSerialRules');

// Read compatibility only: historical single strings and canonical lists.
const parseSerialNumbers = (value) => value == null || value === '' ? [] : String(value).split(',').map((serial) => serial.trim());
const fail = (code) => { throw new AppError(code, 400, code); };
const normalizeSerialNumbers = (input) => {
  if (!Array.isArray(input)) fail('SERIAL_ARRAY_REQUIRED');
  const seen = new Set();
  return input.map((value) => {
    if (typeof value !== 'string') fail('SERIAL_STRING_REQUIRED');
    const serial = value.trim();
    if (!serial) fail('SERIAL_EMPTY');
    if (serial.includes(',')) fail('SERIAL_COMMA_NOT_ALLOWED');
    if ([...serial].length > SERIAL_MAX_LENGTH) fail('SERIAL_TOO_LONG');
    if (seen.has(serial)) fail('SERIAL_DUPLICATE');
    seen.add(serial);
    return serial;
  });
};
const serializeSerialNumbers = (serials) => {
  const serialized = normalizeSerialNumbers(serials).join(',');
  if (Buffer.byteLength(serialized, 'utf8') > SERIAL_STORAGE_MAX_BYTES) fail('SERIAL_STORAGE_TOO_LONG');
  return serialized;
};
const validateSerialNumbers = (type, serials, { allowMissing = false } = {}) => {
  const rule = EQUIPMENT_SERIAL_RULES[type];
  if (!rule) fail('SERIAL_TYPE_INVALID');
  if ((!allowMissing && serials.length < rule.min) || (rule.max != null && serials.length > rule.max)) fail('SERIAL_COUNT_INVALID');
  return serializeSerialNumbers(serials);
};
const serialsFromInput = (row) => {
  if (Object.hasOwn(row, 'serial_numbers')) return normalizeSerialNumbers(row.serial_numbers);
  if (row.serial_number != null && typeof row.serial_number !== 'string') fail('SERIAL_STRING_REQUIRED');
  return normalizeSerialNumbers(parseSerialNumbers(row.serial_number));
};
module.exports = { parseSerialNumbers, normalizeSerialNumbers, serializeSerialNumbers, validateSerialNumbers, serialsFromInput };
