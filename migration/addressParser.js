/**
 * Extracts `district`/`city` out of the legacy branches.sql `address`
 * free-text field, e.g.:
 *   "Toshkent shahar Sergeli tumani Sa'diy ko'chasi 27 uy"       -> city="Toshkent", district="Sergeli"
 *   "Toshkent viloyati Qibray tumani Universitet ko'chasi 5A uy" -> district="Qibray", city=null
 *   "Bo'zatov tumani Kazanketken elati Berdak guzari"            -> district="Bo'zatov", city=null
 *
 * There is no discrete district/city column in the source at all — this is
 * a best-effort text extraction, not a lookup. Either field may legitimately
 * be null (e.g. a rural district address has no "shahar/shahri" token) and
 * that is expected, not an error. `region` is NOT derived here — see
 * lookups.js's regionFromStagCode, which uses the branch's own stag_code
 * prefix instead (deterministic, verified against every row in the dump).
 */

const WORD_CHARS = "A-Za-zʻʼ'.\\u0400-\\u04FF";

// Administrative-level marker words that must never be swallowed into a
// captured district/city name. Without excluding these, a greedy word-count
// quantifier captures back across the region clause too — e.g. "Toshkent
// viloyati Qibray tumani" would otherwise capture "viloyati Qibray" instead
// of just "Qibray" (found and fixed via addressParser test failures — see
// migration/__verify__ style checks run before this file was finalized).
const RESERVED_WORDS = 'viloyati|shahar|shahri|tumani|respublikasi';

// A "name word" is any word-token that (a) starts right after whitespace or
// the beginning of the string — never mid-word — and (b) is not itself one
// of the reserved marker words above.
const NAME_WORD = `(?<=^|\\s)(?!(?:${RESERVED_WORDS})\\b)[${WORD_CHARS}]+`;

const DISTRICT_RE = new RegExp(`(${NAME_WORD}(?:\\s+${NAME_WORD})?)\\s+tumani\\b`, 'i');
// "shahar" and "shahri" share the stem "shah", NOT "shahr" — "shahr(?:i|ar)"
// would match "shahri" but incorrectly require "shahrar" (not a real word)
// instead of the actual word "shahar". Fixed to "shah(?:ar|ri)".
const CITY_RE = new RegExp(`(${NAME_WORD}(?:\\s+${NAME_WORD})?)\\s+shah(?:ar|ri)\\b`, 'i');

function parseAddress(address) {
  if (!address) return { district: null, city: null };

  const districtMatch = address.match(DISTRICT_RE);
  const cityMatch = address.match(CITY_RE);

  return {
    district: districtMatch ? districtMatch[1].trim() : null,
    city: cityMatch ? cityMatch[1].trim() : null,
  };
}

module.exports = { parseAddress };
