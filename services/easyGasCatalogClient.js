// EasyGas's public product catalog API — confirmed separate from, and with a
// different base URL than, their private HMAC-signed warranty-submission API
// (see easyGasWarrantyClient.js). These endpoints are public and require no
// signing at all.
const BASE_URL = process.env.EASYGAS_CATALOG_API_BASE_URL;
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
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
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
// Confirmed path is /product-brands, not /brands.
const getProductBrands = (params) => request('GET', `/product-brands${toQueryString(params)}`);
const getCars = (params) => request('GET', `/cars${toQueryString(params)}`);

module.exports = { getProducts, getProductBrands, getCars };
