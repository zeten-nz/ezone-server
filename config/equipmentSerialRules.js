const EQUIPMENT_SERIAL_RULES = Object.freeze({
  REDUCER: { min: 1, max: 1 },
  CONTROLLER: { min: 1, max: 1 },
  INJECTOR_RAIL: { min: 1, max: 12 },
  CYLINDER: { min: 1, max: null },
});
const SERIAL_MAX_LENGTH = 150;
// MySQL TEXT capacity is bytes, not a business limit on cylinders.
const SERIAL_STORAGE_MAX_BYTES = 65535;
module.exports = { EQUIPMENT_SERIAL_RULES, SERIAL_MAX_LENGTH, SERIAL_STORAGE_MAX_BYTES };
