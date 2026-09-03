/**
 * Canonical branch business-group classification (Beta-2). The ONLY place
 * these strings are defined — controllers/services/DTOs must import from
 * here, never re-declare raw strings.
 *
 * Persisted on branches.branch_type (nullable ENUM — see config/database.js).
 * NULL means UNCLASSIFIED ("Tayinlanmagan") — a real, valid state for every
 * branch that has not yet been classified through the authoritative managed
 * employee onboarding flow (services/managedEmployeeService.js). NEVER
 * inferred from branch names/codes/history, and NEVER sourced from EasyGas's
 * /branches endpoint — local data stays authoritative.
 *
 * The internal name for the `bs` ("Boshqa servis") group is OTHER_SERVICE —
 * the earlier discovery-phase working name THIRD_PARTY is deliberately NOT
 * used anywhere.
 */
const BRANCH_TYPES = ['EASYGAS', 'STAG_SERVICE', 'OTHER_SERVICE'];

// Managed employee username prefix → branch type. Canonical prefixes are
// lowercase; the parser matches them case-insensitively but never rewrites
// the stored username.
const USERNAME_PREFIX_TO_BRANCH_TYPE = {
  eg: 'EASYGAS',
  st: 'STAG_SERVICE',
  bs: 'OTHER_SERVICE',
};

module.exports = { BRANCH_TYPES, USERNAME_PREFIX_TO_BRANCH_TYPE };
