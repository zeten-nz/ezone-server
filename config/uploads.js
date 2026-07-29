/**
 * IMAGE UPLOAD CONFIG
 *
 * Multer disk storage + a magic-byte content check for every file-upload
 * surface in this app (registration request photos, user profile photos,
 * Manual Verification equipment photos). Security notes:
 *
 *   - Filenames are NEVER derived from client input. The on-disk name is
 *     always crypto.randomUUID() + an extension WE choose from the verified
 *     mimetype — this eliminates path traversal and double-extension tricks
 *     entirely, since no attacker-controlled character ever reaches the path.
 *
 *   - multer's fileFilter only inspects the client-declared mimetype/
 *     filename, both trivially spoofable (rename any file to .jpg). A real
 *     signature check (verifyImageMagicBytes) runs after the file is
 *     written, before it's trusted — see registrationRequestController.js
 *     and authController.js's updateProfilePhoto.
 *
 *   - Registration photos are served back only through an authenticated,
 *     ADMIN-only route; profile photos only through an authenticated,
 *     self-only route; Manual Verification photos only through an
 *     authenticated, ADMIN-only route (see warrantyController.streamEquipmentPhoto)
 *     — never express.static for any of the three.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const REGISTRATION_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'registration-photos');
const PROFILE_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'profile-photos');
// Manual Verification workflow: a photo of the seller/product for an
// equipment row whose barcode couldn't be validated. Uploaded independently
// of the warranty JSON submission itself (see warrantyController.uploadEquipmentPhoto)
// — the installer uploads it first and gets back a filename, which then
// travels as a plain string field inside the ordinary warranty create/update
// body, exactly like the other two upload flows below never require their
// owning JSON endpoint to become multipart.
const MANUAL_VERIFICATION_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'manual-verification-photos');
fs.mkdirSync(REGISTRATION_UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PROFILE_UPLOAD_DIR, { recursive: true });
fs.mkdirSync(MANUAL_VERIFICATION_UPLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const MIME_TO_EXTENSION = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

function fileFilter(req, file, cb) {
  const extOk = ALLOWED_EXTENSIONS.includes(path.extname(file.originalname).toLowerCase());
  const mimeOk = Object.prototype.hasOwnProperty.call(MIME_TO_EXTENSION, file.mimetype);
  cb(null, extOk && mimeOk);
}

/** One multer instance per destination directory — same storage/filter rules either way. */
function createUpload(destinationDir) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, destinationDir),
    filename: (req, file, cb) => {
      const ext = MIME_TO_EXTENSION[file.mimetype];
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });

  return multer({
    storage,
    fileFilter,
    limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  });
}

const registrationUpload = createUpload(REGISTRATION_UPLOAD_DIR);
const profileUpload = createUpload(PROFILE_UPLOAD_DIR);
const manualVerificationUpload = createUpload(MANUAL_VERIFICATION_UPLOAD_DIR);

/**
 * Reads the first bytes of a written file and checks them against known
 * image signatures. multer's fileFilter only trusts client-declared
 * metadata — this is the actual content check, run after the file lands
 * on disk and before it's ever persisted/kept.
 */
function verifyImageMagicBytes(filePath) {
  const buffer = Buffer.alloc(12);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true; // JPEG
  if (buffer.toString('hex', 0, 8) === '89504e470d0a1a0a') return true; // PNG
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return true; // WEBP

  return false;
}

/**
 * Wraps multer's single-file middleware so a MulterError (wrong type, too
 * large) becomes the app's standard error envelope instead of falling
 * through to errorHandler.js, which has no knowledge of MulterError and
 * would otherwise default it to an opaque 500.
 */
function wrapSingleUpload(uploadInstance) {
  return function handlePhotoUpload(req, res, next) {
    uploadInstance.single('photo')(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            message: 'File too large',
            errorCode: 'FILE_TOO_LARGE',
            timestamp: new Date().toISOString(),
          });
        }
        return res.status(400).json({
          success: false,
          message: 'Invalid file',
          errorCode: 'INVALID_FILE',
          timestamp: new Date().toISOString(),
        });
      }

      return next(err);
    });
  };
}

const handleRegistrationPhotoUpload = wrapSingleUpload(registrationUpload);
const handleProfilePhotoUpload = wrapSingleUpload(profileUpload);
const handleManualVerificationPhotoUpload = wrapSingleUpload(manualVerificationUpload);

module.exports = {
  UPLOAD_DIR: REGISTRATION_UPLOAD_DIR,
  PROFILE_UPLOAD_DIR,
  MANUAL_VERIFICATION_UPLOAD_DIR,
  MAX_FILE_SIZE_BYTES,
  handleRegistrationPhotoUpload,
  handleProfilePhotoUpload,
  handleManualVerificationPhotoUpload,
  verifyImageMagicBytes,
};
