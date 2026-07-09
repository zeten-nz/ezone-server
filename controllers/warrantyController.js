const { pool } = require('../config/database');
const { validationResult } = require('express-validator');

const createWarrantyForm = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const employeeId = req.user.id;
    const {
      region, city, district, organization_name, organization_phone,
      installer_full_name, warranty_book_number, installation_date,
      vehicle_brand, vehicle_model, vehicle_production_year, vehicle_plate_number,
      vehicle_vin, vehicle_engine_volume, vehicle_engine_power, vehicle_mileage,
      owner_full_name, owner_phone,
      reducer_fuel_type, reducer_manufacturer, reducer_serial_number,
      cylinder_fuel_type, cylinder_manufacturer, cylinder_serial_number,
      stag_controller_manufacturer, stag_controller_serial_number,
      injector_rail_manufacturer, injector_rail_serial_number
    } = req.body;

    const connection = await pool.getConnection();

    await connection.execute(
      `INSERT INTO warranty_forms (
        employee_id, region, city, district, organization_name, organization_phone,
        installer_full_name, warranty_book_number, installation_date,
        vehicle_brand, vehicle_model, vehicle_production_year, vehicle_plate_number,
        vehicle_vin, vehicle_engine_volume, vehicle_engine_power, vehicle_mileage,
        owner_full_name, owner_phone,
        reducer_fuel_type, reducer_manufacturer, reducer_serial_number,
        cylinder_fuel_type, cylinder_manufacturer, cylinder_serial_number,
        stag_controller_manufacturer, stag_controller_serial_number,
        injector_rail_manufacturer, injector_rail_serial_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        employeeId, region, city, district, organization_name, organization_phone,
        installer_full_name, warranty_book_number, installation_date,
        vehicle_brand, vehicle_model, vehicle_production_year, vehicle_plate_number,
        vehicle_vin, vehicle_engine_volume, vehicle_engine_power, vehicle_mileage,
        owner_full_name, owner_phone,
        reducer_fuel_type, reducer_manufacturer, reducer_serial_number,
        cylinder_fuel_type, cylinder_manufacturer, cylinder_serial_number,
        stag_controller_manufacturer, stag_controller_serial_number,
        injector_rail_manufacturer, injector_rail_serial_number
      ]
    );

    connection.release();
    res.status(201).json({ message: 'Warranty form submitted successfully' });
  } catch (error) {
    next(error);
  }
};

const getAllWarrantyForms = async (req, res, next) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = (req.query.search || '').trim();
    const offset = (page - 1) * limit;

    const connection = await pool.getConnection();

    // Optional WHERE clause — searches plate number, owner name, and employee name.
    let whereClause = '';
    const filterParams = [];
    if (search) {
      whereClause = 'WHERE (wf.vehicle_plate_number LIKE ? OR wf.owner_full_name LIKE ? OR u.full_name LIKE ?)';
      filterParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const [countRows] = await connection.execute(
      `SELECT COUNT(*) AS total
       FROM warranty_forms wf
       JOIN users u ON wf.employee_id = u.id
       ${whereClause}`,
      filterParams
    );

    const [forms] = await connection.execute(
      `SELECT wf.*, u.full_name AS employee_name, u.username AS employee_username
       FROM warranty_forms wf
       JOIN users u ON wf.employee_id = u.id
       ${whereClause}
       ORDER BY wf.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      filterParams
    );

    connection.release();

    const totalItems = countRows[0].total;
    const totalPages = Math.ceil(totalItems / limit);

    res.json({
      data: forms,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages,
        hasNext:     page < totalPages,
        hasPrevious: page > 1,
      },
    });
  } catch (error) {
    next(error);
  }
};

const getWarrantyFormDetail = async (req, res, next) => {
  try {
    const { formId } = req.params;
    const connection = await pool.getConnection();

    const [forms] = await connection.execute(
      `SELECT wf.*, u.full_name as employee_name, u.username as employee_username
       FROM warranty_forms wf
       JOIN users u ON wf.employee_id = u.id
       WHERE wf.id = ?`,
      [formId]
    );

    connection.release();

    if (forms.length === 0) {
      return res.status(404).json({ success: false, message: 'Warranty form not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    res.json(forms[0]);
  } catch (error) {
    next(error);
  }
};

const deleteWarrantyForm = async (req, res, next) => {
  try {
    const { formId } = req.params;
    const connection = await pool.getConnection();

    await connection.execute(
      'DELETE FROM warranty_forms WHERE id = ?',
      [formId]
    );

    connection.release();
    res.json({ message: 'Warranty form deleted successfully' });
  } catch (error) {
    next(error);
  }
};

const searchWarrantyForms = async (req, res, next) => {
  try {
    const { search, filterType } = req.query;
    const connection = await pool.getConnection();

    let query = `SELECT wf.*, u.full_name as employee_name, u.username as employee_username
                 FROM warranty_forms wf
                 JOIN users u ON wf.employee_id = u.id
                 WHERE 1=1`;
    const params = [];

    if (search) {
      if (filterType === 'vehicle_plate') {
        query += ' AND wf.vehicle_plate_number LIKE ?';
        params.push(`%${search}%`);
      } else if (filterType === 'owner_name') {
        query += ' AND wf.owner_full_name LIKE ?';
        params.push(`%${search}%`);
      } else if (filterType === 'employee_name') {
        query += ' AND u.full_name LIKE ?';
        params.push(`%${search}%`);
      } else {
        query += ' AND (wf.vehicle_plate_number LIKE ? OR wf.owner_full_name LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
      }
    }

    query += ' ORDER BY wf.created_at DESC';

    const [forms] = await connection.execute(query, params);
    connection.release();

    res.json(forms);
  } catch (error) {
    next(error);
  }
};

const updateWarrantyForm = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg, errorCode: 'VALIDATION_ERROR', timestamp: new Date().toISOString() });
    }

    const formId = parseInt(req.params.formId, 10);
    const { id: userId, role } = req.user;

    const connection = await pool.getConnection();

    const [existing] = await connection.execute(
      'SELECT id, employee_id, created_at FROM warranty_forms WHERE id = ?',
      [formId]
    );

    if (existing.length === 0) {
      connection.release();
      return res.status(404).json({ success: false, message: 'Warranty form not found', errorCode: 'NOT_FOUND', timestamp: new Date().toISOString() });
    }

    const form = existing[0];

    if (role !== 'ADMIN') {
      if (form.employee_id !== userId) {
        connection.release();
        return res.status(403).json({ success: false, message: 'Access denied', errorCode: 'FORBIDDEN', timestamp: new Date().toISOString() });
      }
      const hoursElapsed = (Date.now() - new Date(form.created_at).getTime()) / 3_600_000;
      if (hoursElapsed > 24) {
        connection.release();
        return res.status(403).json({ success: false, message: 'Forms can only be edited within 24 hours of submission', errorCode: 'EDIT_WINDOW_EXPIRED', timestamp: new Date().toISOString() });
      }
    }

    const {
      region, city, district, organization_name, organization_phone,
      installer_full_name, warranty_book_number, installation_date,
      vehicle_brand, vehicle_model, vehicle_production_year, vehicle_plate_number,
      vehicle_vin, vehicle_engine_volume, vehicle_engine_power, vehicle_mileage,
      owner_full_name, owner_phone,
      reducer_fuel_type, reducer_manufacturer, reducer_serial_number,
      cylinder_fuel_type, cylinder_manufacturer, cylinder_serial_number,
      stag_controller_manufacturer, stag_controller_serial_number,
      injector_rail_manufacturer, injector_rail_serial_number,
    } = req.body;

    await connection.execute(
      `UPDATE warranty_forms SET
         region = ?, city = ?, district = ?, organization_name = ?, organization_phone = ?,
         installer_full_name = ?, warranty_book_number = ?, installation_date = ?,
         vehicle_brand = ?, vehicle_model = ?, vehicle_production_year = ?,
         vehicle_plate_number = ?, vehicle_vin = ?,
         vehicle_engine_volume = ?, vehicle_engine_power = ?, vehicle_mileage = ?,
         owner_full_name = ?, owner_phone = ?,
         reducer_fuel_type = ?, reducer_manufacturer = ?, reducer_serial_number = ?,
         cylinder_fuel_type = ?, cylinder_manufacturer = ?, cylinder_serial_number = ?,
         stag_controller_manufacturer = ?, stag_controller_serial_number = ?,
         injector_rail_manufacturer = ?, injector_rail_serial_number = ?
       WHERE id = ?`,
      [
        region, city, district, organization_name, organization_phone,
        installer_full_name, warranty_book_number, installation_date,
        vehicle_brand, vehicle_model, vehicle_production_year,
        vehicle_plate_number, vehicle_vin,
        vehicle_engine_volume, vehicle_engine_power, vehicle_mileage,
        owner_full_name, owner_phone,
        reducer_fuel_type, reducer_manufacturer, reducer_serial_number,
        cylinder_fuel_type, cylinder_manufacturer, cylinder_serial_number,
        stag_controller_manufacturer, stag_controller_serial_number,
        injector_rail_manufacturer, injector_rail_serial_number,
        formId,
      ]
    );

    const [updated] = await connection.execute(
      'SELECT * FROM warranty_forms WHERE id = ?',
      [formId]
    );

    connection.release();
    res.json(updated[0]);
  } catch (error) {
    next(error);
  }
};

const getMyWarrantyForms = async (req, res, next) => {
  try {
    // Always use the authenticated user's ID — never accept employeeId from query params.
    const employeeId = req.user.id;
    const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = (req.query.search || '').trim();
    const offset = (page - 1) * limit;

    const connection = await pool.getConnection();

    // Base clause always scopes results to this employee.
    let whereClause = 'WHERE wf.employee_id = ?';
    const filterParams = [employeeId];

    if (search) {
      whereClause += ' AND (wf.vehicle_plate_number LIKE ? OR wf.owner_full_name LIKE ?)';
      filterParams.push(`%${search}%`, `%${search}%`);
    }

    const [countRows] = await connection.execute(
      `SELECT COUNT(*) AS total FROM warranty_forms wf ${whereClause}`,
      filterParams
    );

    const [forms] = await connection.execute(
      `SELECT wf.*
       FROM warranty_forms wf
       ${whereClause}
       ORDER BY wf.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      filterParams
    );

    connection.release();

    const totalItems = countRows[0].total;
    const totalPages = Math.ceil(totalItems / limit);

    res.json({
      data: forms,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages,
        hasNext:     page < totalPages,
        hasPrevious: page > 1,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createWarrantyForm,
  updateWarrantyForm,
  getAllWarrantyForms,
  getWarrantyFormDetail,
  deleteWarrantyForm,
  searchWarrantyForms,
  getMyWarrantyForms,
};
