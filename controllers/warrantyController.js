const { pool } = require('../config/database');
const { validationResult } = require('express-validator');

const createWarrantyForm = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
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
    console.error('Create warranty form error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

const getAllWarrantyForms = async (req, res) => {
  try {
    const connection = await pool.getConnection();

    const [forms] = await connection.execute(
      `SELECT wf.*, u.full_name as employee_name, u.username as employee_username
       FROM warranty_forms wf
       JOIN users u ON wf.employee_id = u.id
       ORDER BY wf.created_at DESC`
    );

    connection.release();
    res.json(forms);
  } catch (error) {
    console.error('Get warranty forms error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

const getWarrantyFormDetail = async (req, res) => {
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
      return res.status(404).json({ message: 'Warranty form not found' });
    }

    res.json(forms[0]);
  } catch (error) {
    console.error('Get warranty form detail error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

const deleteWarrantyForm = async (req, res) => {
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
    console.error('Delete warranty form error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

const searchWarrantyForms = async (req, res) => {
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
    console.error('Search warranty forms error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  createWarrantyForm,
  getAllWarrantyForms,
  getWarrantyFormDetail,
  deleteWarrantyForm,
  searchWarrantyForms
};
