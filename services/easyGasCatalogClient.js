const { buildSignedHeaders } = require('../utils/easyGasSigning');

// EasyGas's integration GET API. CURRENT CONTRACT (supersedes the retired
// /public/api/{products,product-brands,cars} catalog paths — do not
// reintroduce those): every GET endpoint lives under the SAME base URL the
// warranty POST already uses (EASYGAS_WARRANTY_API_BASE_URL, e.g.
// https://admin.stag.uz/api/integrations/warranty):
//
//   GET {base}/brands
//   GET {base}/products
//   GET {base}/cars
//   GET {base}/branches
//   GET {base}/verify
//
// All five are HMAC-signed with the shared EASYGAS_SHARED_SECRET via
// utils/easyGasSigning.js — a GET signs an empty body, so the signing base
// is `${timestamp}.` (trailing dot mandatory). No second HMAC
// implementation exists anywhere; this file only ever calls the shared
// buildSignedHeaders.
// Trailing slashes are stripped so a base URL configured as
// ".../api/integrations/warranty/" still composes ".../warranty/brands",
// never ".../warranty//brands". Paths below are appended verbatim — the
// base can never be duplicated into the composed URL.
const BASE_URL = process.env.EASYGAS_WARRANTY_API_BASE_URL
  ? process.env.EASYGAS_WARRANTY_API_BASE_URL.replace(/\/+$/, '')
  : process.env.EASYGAS_WARRANTY_API_BASE_URL;
const SHARED_SECRET = process.env.EASYGAS_SHARED_SECRET;
const REQUEST_TIMEOUT_MS = 15_000;

const toQueryString = (params) => {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries).toString()}`;
};

/**
 * Pure HTTP client for EasyGas's integration GET endpoints — never acquires
 * or holds a DB connection. This function NEVER rejects — network failures,
 * timeouts, and JSON-parse failures all resolve to
 * `{ ok: false, networkError: true, ... }` instead of throwing, because one
 * caller (the catalog sync sweep, services/easyGasCatalogSyncSweep.js) runs
 * in a detached setInterval context where an uncaught rejection would trip
 * server.js's unhandledRejection handler and kill the entire PM2 worker.
 *
 * Response-shape mapping deliberately does NOT live here — this client
 * returns whatever JSON EasyGas sent, verbatim, and
 * easyGasCatalogSyncService.js owns all field mapping (tolerantly, and
 * fail-closed: an unrecognized shape is skipped/reported, never guessed at).
 */
const request = async (method, path) => {
  if (!BASE_URL || !SHARED_SECRET) {
    return { ok: false, status: 0, data: null, networkError: true, errorMessage: 'EASYGAS_WARRANTY_API_BASE_URL/EASYGAS_SHARED_SECRET not configured' };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // GET-only client — every request signs an empty body (`${timestamp}.`).
    const signedHeaders = buildSignedHeaders(SHARED_SECRET, '');
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...signedHeaders },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data, networkError: false };
  } catch (error) {
    return { ok: false, status: 0, data: null, networkError: true, errorMessage: error.message };
  } finally {
    clearTimeout(timeoutId);
  }
};

const getBrands = (params) => request('GET', `/brands${toQueryString(params)}`);
const getProducts = (params) => request('GET', `/products${toQueryString(params)}`);
const getCars = (params) => request('GET', `/cars${toQueryString(params)}`);

// Branches: a confirmed real endpoint, but deliberately NOT wired into any
// synchronization. LOCAL branches remain authoritative — branch identity,
// employee assignment, and the branch_stag_code snapshot sent to EasyGas all
// come from our own branches table (branches.code), and replacing that
// ownership with an EasyGas pull would silently alter branch identity and
// historical warranty snapshots. Exposed here only for future
// verification/mapping use; nothing calls it in a sync.
const getBranches = (params) => request('GET', `/branches${toQueryString(params)}`);

// Verification/lookup endpoint — REAL CONTRACT (confirmed by a signed
// production probe, 2026-08-26): requires exactly one of the query params
// `phone`, `vin`, or `serial`; a parameterless call returns 422
// `{success:false, errors:[{field:"query", code:"FIELD_REQUIRED", ...}]}`
// (which is a validation rejection, NOT an auth failure — the signature was
// accepted). Callers must always pass one of those params (enforced in
// catalogSyncController.verifyEasyGasConnection); the success-response
// shape is not yet captured, so the body is passed through uninterpreted.
// No warranty or catalog-sync behavior depends on this endpoint.
const verify = (params) => request('GET', `/verify${toQueryString(params)}`);

module.exports = { getBrands, getProducts, getCars, getBranches, verify };
