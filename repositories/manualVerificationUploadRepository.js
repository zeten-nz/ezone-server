/**
 * All raw SQL for manual_verification_photo_uploads — a small tracking
 * table recording who uploaded each Manual Verification photo, independent
 * of whether it ever ends up attached to a real warranty_equipment row (see
 * config/database.js's migration comment for why there's no FK between them).
 */

const create = async (connection, { filename, uploadedBy }) => {
  await connection.execute(
    'INSERT INTO manual_verification_photo_uploads (filename, uploaded_by) VALUES (?, ?)',
    [filename, uploadedBy]
  );
};

const findByFilename = async (connection, filename) => {
  const [rows] = await connection.execute(
    'SELECT * FROM manual_verification_photo_uploads WHERE filename = ?',
    [filename]
  );
  return rows[0] || null;
};

/**
 * Orphan cleanup (services/manualVerificationUploadCleanupSweep.js) — an
 * upload older than `olderThanHours` whose filename is not referenced by any
 * warranty_equipment row was uploaded but never actually used in a
 * submission (the installer abandoned the form, or re-uploaded and replaced
 * it before saving). The grace period exists so an upload mid-form-fill
 * (uploaded, warranty not yet submitted) is never swept out from under it.
 */
const findOrphaned = async (connection, olderThanHours) => {
  const [rows] = await connection.execute(
    `SELECT u.id, u.filename FROM manual_verification_photo_uploads u
     WHERE u.created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND NOT EXISTS (
         SELECT 1 FROM warranty_equipment we WHERE we.manual_verification_photo_filename = u.filename
       )`,
    [olderThanHours]
  );
  return rows;
};

const deleteByIds = async (connection, ids) => {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await connection.execute(`DELETE FROM manual_verification_photo_uploads WHERE id IN (${placeholders})`, ids);
};

module.exports = { create, findByFilename, findOrphaned, deleteByIds };
