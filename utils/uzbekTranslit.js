/**
 * Deterministic Cyrillic → Uzbek-Latin IDENTIFIER transliteration for the
 * production employee seed (username generation ONLY — the human-readable
 * users.full_name always keeps the source's original spelling and is never
 * transliterated).
 *
 * Identifier-style choices (per the approved seed spec): Ж→j, Х→x, Ш→sh,
 * Ч→ch, Ё→yo, Ю→yu, Я→ya, Қ→q, Ғ→g, Ҳ→h, Ў→o. The output is a lowercase
 * [a-z0-9]* slug — apostrophes (oʻ/gʻ/o'), punctuation, and any character
 * with no mapping are stripped rather than guessed at, so the same input
 * always yields the same slug.
 */

// Lowercase Cyrillic → Latin. Input is lowercased before lookup, so only
// lowercase keys are needed. Russian letters that appear in Uzbek names
// (ц/щ/ы/ь/ъ/э) are included; hard/soft signs vanish.
const CYRILLIC_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Uzbek-specific Cyrillic
  қ: 'q', ғ: 'g', ҳ: 'h', ў: 'o',
};

/**
 * Transliterates arbitrary text to a lowercase [a-z0-9]* identifier slug.
 * Latin input passes through (lowercased, diacritics decomposed and
 * stripped); unknown characters are dropped, never replaced with guesses.
 */
const transliterateToSlug = (text) => {
  const lower = String(text || '').toLowerCase();
  let out = '';
  for (const ch of lower) {
    out += CYRILLIC_MAP[ch] !== undefined ? CYRILLIC_MAP[ch] : ch;
  }
  // NFKD splits Latin diacritics (and the ʻ modifier letter used in oʻ/gʻ)
  // into base char + combining mark; the filter then keeps only [a-z0-9].
  return out.normalize('NFKD').replace(/[^a-z0-9]/g, '');
};

/**
 * Given-name extraction for username generation (approved rules):
 * source names are normally "SURNAME GIVEN_NAME PATRONYMIC" → token #2.
 * A single usable token is used as-is; an unusable token #2 (an initial
 * like "Ж." — slug shorter than 2 chars) falls back to token #1. Returns
 * null when no token yields a usable slug — the caller reports
 * INVALID_NAME rather than guessing a semantic correction.
 */
const extractGivenNameSlug = (fullName) => {
  const tokens = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const usable = (token) => {
    const slug = transliterateToSlug(token);
    return slug.length >= 2 ? slug : null;
  };
  if (tokens.length >= 2) {
    const given = usable(tokens[1]);
    if (given) return given;
  }
  return usable(tokens[0]);
};

module.exports = { transliterateToSlug, extractGivenNameSlug };
