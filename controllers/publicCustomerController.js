/**
 * Public customer warranty lookup — restored (previously removed as an
 * unauthenticated PII exposure, see docs/09-security.md). Reinstated as a
 * deliberate, explicitly-accepted product decision: no auth mechanism has
 * been added back.
 *
 * Mirrors warrantyController.searchWarrantyForms exactly: no service layer
 * (this is a pure read, same as every other list endpoint in that
 * controller), repository -> attachEquipment -> the existing warranty DTO.
 */

const { pool } = require('../config/database');
const { validationResult } = require('express-validator');
const warrantyRepository = require('../repositories/warrantyRepository');
const { attachEquipment } = require('../utils/warrantyEquipment');
const { toWarrantyListResponse } = require('../dtos/warrantyDTO');
const { normalizePhone } = require('../utils/phoneFormat');

const getWarrantiesByPhone = async (req, res, next) => {
  let connection;
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const phone = normalizePhone(req.body.phone);
    connection = await pool.getConnection();

    const rows = await warrantyRepository.findByOwnerPhone(connection, phone);
    const forms = await attachEquipment(connection, rows);

    res.json(toWarrantyListResponse(forms));
  } catch (error) {
    next(error);
  } finally {
    if (connection) connection.release();
  }
};

module.exports = { getWarrantiesByPhone };
