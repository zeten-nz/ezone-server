const { PHONE_REGEX } = require('../config/validation');

/**
 * Best-effort canonicalization of an owner_phone value to EasyGas's expected
 * +998XXXXXXXXX shape before a warranty push. Defensive/future-proofing
 * only — every warranty_forms.owner_phone value in production today is
 * already clean +998XXXXXXXXX (frontend enforces PHONE_REGEX at
 * submission), so this isn't fixing an active bug.
 *
 * Never throws, never invents digits: anything that doesn't cleanly map to
 * one of the recognized shapes is returned completely unchanged — sending a
 * still-malformed number and letting EasyGas's own validation reject it
 * (visible via easygas_last_error) is safer than silently guessing wrong
 * digits into a customer's phone number.
 */
const normalizeToEasyGasPhone = (phone) => {
  if (typeof phone !== 'string') return phone;
  if (PHONE_REGEX.test(phone)) return phone;

  const digitsOnly = phone.replace(/[^\d]/g, '');

  if (/^998\d{9}$/.test(digitsOnly)) return `+${digitsOnly}`;
  if (/^8\d{9}$/.test(digitsOnly)) return `+998${digitsOnly.slice(1)}`;
  if (/^\d{9}$/.test(digitsOnly)) return `+998${digitsOnly}`;

  return phone;
};

module.exports = { normalizeToEasyGasPhone };
