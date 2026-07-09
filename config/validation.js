// Shared validation constants used across route files — defined once per
// backend runtime (the frontend has its own copy in src/config/phone.js,
// since the two are separate JS runtimes that can't share a literal module).
const PHONE_REGEX = /^\+998\d{9}$/;

module.exports = { PHONE_REGEX };
