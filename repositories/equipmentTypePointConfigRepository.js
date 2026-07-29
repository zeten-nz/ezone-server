/**
 * All raw SQL for equipment_type_point_configs/equipment_type_point_config_history.
 * Mirrors productPointConfigRepository.js exactly, keyed by equipment_type
 * instead of product_id — used only for a typed cylinder today (the one
 * equipment type that can be submitted with no product_id at all). Absence
 * of a row means 0 points, same "unconfigured, not a special state"
 * convention as the per-product table.
 */

const getPoints = async (connection, equipmentType) => {
  const [rows] = await connection.execute(
    'SELECT points FROM equipment_type_point_configs WHERE equipment_type = ?',
    [equipmentType]
  );
  return rows[0]?.points ?? 0;
};

/**
 * Upserts the config value and writes a history row in the same call —
 * old_points is read fresh here (not trusted from the caller) so the
 * history row is always accurate even under concurrent admin edits.
 */
const upsert = async (connection, { equipmentType, points, updatedBy }) => {
  const [existingRows] = await connection.execute(
    'SELECT points FROM equipment_type_point_configs WHERE equipment_type = ?',
    [equipmentType]
  );
  const oldPoints = existingRows[0]?.points ?? null;

  await connection.execute(
    `INSERT INTO equipment_type_point_configs (equipment_type, points, updated_by)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE points = VALUES(points), updated_by = VALUES(updated_by)`,
    [equipmentType, points, updatedBy]
  );

  await connection.execute(
    `INSERT INTO equipment_type_point_config_history (equipment_type, old_points, new_points, changed_by)
     VALUES (?, ?, ?, ?)`,
    [equipmentType, oldPoints, points, updatedBy]
  );
};

// Only CYLINDER can currently be submitted with no product_id (see
// warrantyService.resolveEquipment's typed-cylinder branch) — the other 3
// enum values can never actually use this table, so the list deliberately
// only ever surfaces CYLINDER, synthesized with a 0 default if unconfigured,
// rather than showing 3 permanently-irrelevant rows.
const CONFIGURABLE_TYPES = ['CYLINDER'];

const listAll = async (connection) => {
  const [rows] = await connection.execute('SELECT equipment_type, points, updated_at FROM equipment_type_point_configs');
  const byType = new Map(rows.map((r) => [r.equipment_type, r]));
  return CONFIGURABLE_TYPES.map((equipmentType) => ({
    equipment_type: equipmentType,
    points: byType.get(equipmentType)?.points ?? 0,
    updated_at: byType.get(equipmentType)?.updated_at ?? null,
  }));
};

module.exports = { getPoints, upsert, listAll, CONFIGURABLE_TYPES };
