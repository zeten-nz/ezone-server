/**
 * Best-effort +998 (Uzbekistan) phone-number canonicalization.
 *
 * owner_phone is always stored as '+998' followed by 9 digits, no
 * separators (e.g. '+998901234567' — see config/mockData.js). A client may
 * reasonably send it with spaces/dashes, without the '+', or as a bare
 * 9-digit local number — this strips everything down to digits and
 * reconstructs the stored shape so a lookup isn't defeated by formatting.
 */
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;

  // Bare local number (9 digits, no country code) — prefix it.
  if (digits.length === 9) return `+998${digits}`;

  // Already has the country code digits (with or without a leading '+').
  return `+${digits}`;
}

module.exports = { normalizePhone };
