/**
 * Best-effort Uzbekistan phone-number canonicalization for COMPARISON only
 * — never used to rewrite stored data.
 *
 * owner_phone is not stored under one consistent shape across existing
 * rows (confirmed directly against production: some rows are a bare
 * 9-digit national number like '991236547', with no country code or '+' at
 * all — not the '+998XXXXXXXXX' shape this file originally assumed). A
 * client may also send the number in any common representation: with or
 * without '+998'/'998', with spaces, dashes, or parentheses.
 *
 * Rather than trying to reconstruct one canonical stored shape (which
 * requires knowing which convention a given row happens to use),
 * normalization here reduces to the one thing that's actually stable
 * across every representation: the 9-digit national significant number.
 * Comparison against the database applies this exact same reduction to
 * owner_phone at query time (see repositories/warrantyRepository.js's
 * findByOwnerPhone) so both sides are always compared on equal footing,
 * regardless of which format either one happens to use.
 */
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;

  // Last 9 digits = the national significant number, independent of
  // whether a '998' country code prefix was present on either side.
  return digits.slice(-9);
}

module.exports = { normalizePhone };
