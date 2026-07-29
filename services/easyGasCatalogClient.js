const { buildSignedHeaders } = require('../utils/easyGasSigning');

// EasyGas's catalog API — per EasyGas's own request, now shares the SAME
// signed base URL/secret as the private warranty-submission API (see
// easyGasWarrantyClient.js), replacing the old separate, unsigned public
// catalog API. EASYGAS_CATALOG_API_BASE_URL is retired; do not reintroduce it.
const BASE_URL = process.env.EASYGAS_WARRANTY_API_BASE_URL;
const SHARED_SECRET = process.env.EASYGAS_SHARED_SECRET;
const REQUEST_TIMEOUT_MS = 3000;

const toQueryString = (params) => {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries).toString()}`;
};

/**
 * Pure HTTP client for EasyGas's public catalog API — never acquires or
 * holds a DB connection. This function NEVER rejects — network failures,
 * timeouts, and JSON-parse failures all resolve to
 * `{ ok: false, networkError: true, ... }` instead of throwing, because the
 * only caller (the catalog sync sweep, services/easyGasCatalogSyncSweep.js)
 * runs in a detached setInterval context where an uncaught rejection would
 * trip server.js's unhandledRejection handler and kill the entire PM2 worker.
 */
const request = async (method, path) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // GET-only client — every request signs an empty body.
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

const getProducts = (params) => request('GET', `/products${toQueryString(params)}`);
// Path is /brands under the new signed API — distinct from the old public
// API's /product-brands, since this is a different endpoint family.
const getProductBrands = (params) => request('GET', `/brands${toQueryString(params)}`);
const getCars = (params) => request('GET', `/cars${toQueryString(params)}`);
// New endpoint EasyGas mentioned for real STAG branch codes. Deliberately
// NOT wired into easyGasCatalogSyncService.js/easyGasCatalogSyncSweep.js in
// this batch — branches.easygas_stag_code is a manually ops-entered value
// (see config/database.js), not something auto-synced yet. Exposed here so
// a future sync can use it.
const getBranches = (params) => request('GET', `/branches${toQueryString(params)}`);

module.exports = { getProducts, getProductBrands, getCars, getBranches };
