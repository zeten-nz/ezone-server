const { USERNAME_PREFIX_TO_BRANCH_TYPE } = require('../config/branchTypes');

/**
 * THE single backend source of truth for parsing managed employee usernames
 * (Beta-2). Never duplicated in controllers/services — everything imports
 * parseManagedEmployeeUsername from here. (The frontend keeps a small
 * presentation-only mirror for its live preview; this parser remains
 * authoritative.)
 *
 * Grammar: <prefix>_<human-part>_<region-code>_<branch-number>
 *   - prefix:        eg | st | bs (case-insensitive; canonical lowercase)
 *   - human-part:    one or MORE '_'-separated non-empty tokens
 *                    (e.g. "ali", "service_master") — so the parser works
 *                    from BOTH ENDS, never a naive split('_')[n]
 *   - region-code:   exactly 2 digits (second-to-last token)
 *   - branch-number: 1+ digits (last token)
 *
 * The final two tokens reconstruct ONLY the local branches.code
 * (`01_1` → `01/1`) for consistency validation against the SELECTED local
 * branch. The region code is deliberately NEVER translated into a
 * human-readable region here — branches.region/district/city stay the
 * source of truth; no hardcoded region taxonomy exists.
 *
 * Returns (never throws — callers decide which failures are errors in their
 * context):
 *   success: { managed: true, prefix, branchType, humanPart, regionCode,
 *              branchNumber, branchCode }
 *   failure: { managed: false, reason: 'INVALID_EMPLOYEE_USERNAME_FORMAT'
 *                                    | 'INVALID_EMPLOYEE_USERNAME_PREFIX' }
 *   - PREFIX is reported only when the rest of the shape is a valid managed
 *     username but the 2-letter prefix isn't eg/st/bs — so the admin gets
 *     the more specific message; every other malformation is FORMAT.
 */
const parseManagedEmployeeUsername = (username) => {
  const raw = String(username || '');
  const parts = raw.split('_');
  const invalid = (reason) => ({ managed: false, reason });

  if (parts.length < 4) return invalid('INVALID_EMPLOYEE_USERNAME_FORMAT');

  const prefix = parts[0];
  const branchNumber = parts[parts.length - 1];
  const regionCode = parts[parts.length - 2];
  const humanTokens = parts.slice(1, -2);

  const shapeValid =
    /^\d{2}$/.test(regionCode) &&           // exactly 2 digits
    /^\d+$/.test(branchNumber) &&           // 1+ digits
    humanTokens.length >= 1 &&
    humanTokens.every((t) => t.length > 0); // no empty human tokens (eg__01_1)

  if (!shapeValid || !/^[A-Za-z]{2}$/.test(prefix)) {
    return invalid('INVALID_EMPLOYEE_USERNAME_FORMAT');
  }

  const branchType = USERNAME_PREFIX_TO_BRANCH_TYPE[prefix.toLowerCase()];
  if (!branchType) return invalid('INVALID_EMPLOYEE_USERNAME_PREFIX');

  return {
    managed: true,
    prefix: prefix.toLowerCase(),
    branchType,
    humanPart: humanTokens.join('_'),
    regionCode,
    branchNumber,
    branchCode: `${regionCode}/${branchNumber}`,
  };
};

module.exports = { parseManagedEmployeeUsername };
