const AppError = require('../utils/AppError');
const warrantyRepository = require('../repositories/warrantyRepository');
const equipmentRepository = require('../repositories/equipmentRepository');
const productRepository = require('../repositories/productRepository');

const { REQUIRED_EQUIPMENT_TYPES } = equipmentRepository;
const EDIT_WINDOW_HOURS = 24;

const getEmployeeSnapshot = (connection, employeeId) => warrantyRepository.getEmployeeSnapshot(connection, employeeId);

/**
 * Resolves each submitted equipment row's product_id into a full catalog
 * record — product_name is always server-derived here, never accepted from
 * the client (a client-supplied name could corrupt the category/brand
 * groupings Reports' "Products Installed" view depends on). Also validates
 * the submitted set is exactly the 4 required types, each exactly once —
 * the DB's UNIQUE(warranty_form_id, equipment_type) constraint guards
 * against duplicates but can't by itself guarantee completeness.
 */
const resolveEquipment = async (connection, equipmentInput) => {
  const rows = Array.isArray(equipmentInput) ? equipmentInput : [];
  const types = rows.map((r) => r.equipment_type);
  const uniqueTypes = new Set(types);
  const isComplete = rows.length === REQUIRED_EQUIPMENT_TYPES.length
    && uniqueTypes.size === REQUIRED_EQUIPMENT_TYPES.length
    && REQUIRED_EQUIPMENT_TYPES.every((t) => uniqueTypes.has(t));
  if (!isComplete) {
    throw new AppError('All 4 equipment types are required, each exactly once', 400, 'EQUIPMENT_INCOMPLETE');
  }

  const resolved = [];
  for (const row of rows) {
    const product = await productRepository.findById(connection, row.product_id);
    if (!product) {
      throw new AppError(`Product not found for ${row.equipment_type}`, 404, 'PRODUCT_NOT_FOUND');
    }
    if (!product.is_active) {
      throw new AppError(`Selected ${row.equipment_type} product is no longer active`, 409, 'PRODUCT_INACTIVE');
    }
    resolved.push({
      equipment_type: row.equipment_type,
      product_id: product.id,
      product_name: `${product.brand} ${product.model || ''}`.trim(),
      serial_number: row.serial_number || null,
    });
  }
  return resolved;
};

const createWarrantyForm = async (connection, employeeId, data) => {
  const snapshot = await getEmployeeSnapshot(connection, employeeId);
  if (!snapshot) {
    throw new AppError(
      'Your profile is missing branch information — ask an admin to assign your branch',
      400,
      'INCOMPLETE_PROFILE'
    );
  }
  const resolvedEquipment = await resolveEquipment(connection, data.equipment);

  await connection.beginTransaction();
  try {
    const formId = await warrantyRepository.insert(connection, employeeId, snapshot, data);
    await equipmentRepository.upsertMany(connection, formId, resolvedEquipment);
    await connection.commit();
    return formId;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
};

const updateWarrantyForm = async (connection, formId, userId, role, data) => {
  const existing = await warrantyRepository.findOwnershipInfo(connection, formId);
  if (!existing) {
    throw new AppError('Warranty form not found', 404, 'NOT_FOUND');
  }
  if (role !== 'ADMIN') {
    if (existing.employee_id !== userId) {
      throw new AppError('Access denied', 403, 'FORBIDDEN');
    }
    const hoursElapsed = (Date.now() - new Date(existing.created_at).getTime()) / 3_600_000;
    if (hoursElapsed > EDIT_WINDOW_HOURS) {
      throw new AppError('Forms can only be edited within 24 hours of submission', 403, 'EDIT_WINDOW_EXPIRED');
    }
  }

  const resolvedEquipment = await resolveEquipment(connection, data.equipment);

  await connection.beginTransaction();
  try {
    await warrantyRepository.update(connection, formId, data);
    await equipmentRepository.upsertMany(connection, formId, resolvedEquipment);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
};

const deleteWarrantyForm = async (connection, formId) => {
  await warrantyRepository.deleteById(connection, formId);
};

module.exports = {
  getEmployeeSnapshot,
  resolveEquipment,
  createWarrantyForm,
  updateWarrantyForm,
  deleteWarrantyForm,
  EDIT_WINDOW_HOURS,
};
