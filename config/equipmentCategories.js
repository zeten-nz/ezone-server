/**
 * The warranty form's 4 fixed equipment slots, and which products.category
 * values are searchable from each slot's autocomplete. CONTROLLER is the
 * new canonical category; ECU is included for the Controller slot only so
 * any product created before this redesign (tagged ECU) stays findable.
 */
const EQUIPMENT_TYPES = ['REDUCER', 'CYLINDER', 'CONTROLLER', 'INJECTOR_RAIL'];

const EQUIPMENT_TYPE_TO_CATEGORIES = {
  REDUCER: ['REDUCER'],
  CYLINDER: ['CYLINDER'],
  CONTROLLER: ['CONTROLLER', 'ECU'],
  INJECTOR_RAIL: ['INJECTOR_RAIL'],
};

module.exports = { EQUIPMENT_TYPES, EQUIPMENT_TYPE_TO_CATEGORIES };
