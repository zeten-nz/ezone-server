const { buildSignedHeaders } = require('../utils/easyGasSigning');

// EasyGas's catalog API — per EasyGas's own request, shares the SAME signed
// secret as the private warranty-submission API (see easyGasWarrantyClient.js),
// but lives under a DIFFERENT path on the same host: /public/api/... rather
// than /api/integrations/warranty. EASYGAS_WARRANTY_API_BASE_URL is the full
// warranty endpoint URL (e.g. https://admin.stag.uz/api/integrations/warranty)
// — not usable as a string-concatenation prefix for the catalog paths, which
// are confirmed real endpoints (not invented): /public/api/products,
// /public/api/product-brands, /public/api/cars. ORIGIN below is just the
// protocol+host portion of that same configured URL — no separate catalog
// base URL env var exists or is introduced here (EASYGAS_CATALOG_API_BASE_URL
// stays retired, per the prior note this replaces).
const ORIGIN = process.env.EASYGAS_WARRANTY_API_BASE_URL ? new URL(process.env.EASYGAS_WARRANTY_API_BASE_URL).origin : undefined;
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
  if (!ORIGIN) {
    return { ok: false, status: 0, data: null, networkError: true, errorMessage: 'EASYGAS_WARRANTY_API_BASE_URL not configured' };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // GET-only client — every request signs an empty body.
    const signedHeaders = buildSignedHeaders(SHARED_SECRET, '');
    const response = await fetch(`${ORIGIN}${path}`, {
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

// Confirmed real paths — do not change without a real, confirmed replacement.
const getProducts = (params) => request('GET', `/public/api/products${toQueryString(params)}`);
const getProductBrands = (params) => request('GET', `/public/api/product-brands${toQueryString(params)}`);
const getCars = (params) => request('GET', `/public/api/cars${toQueryString(params)}`);
// Branches endpoint — deliberately NEVER wired into any sync (FINAL
// architecture decision: LOCAL branches are authoritative; branch_stag_code
// comes from our own branches.code, and no EasyGas branch synchronization
// exists or will be added — see easyGasWarrantySyncService.js's
// branch_stag_code note). This function is dead-but-harmless: kept only so
// the exported client surface doesn't change, path unconfirmed against the
// current API (a /branches probe 404s; /public/api/branches 401s — neither
// is used). Do not wire it into a sync without revisiting that decision.
const getBranches = (params) => request('GET', `/branches${toQueryString(params)}`);

module.exports = { getProducts, getProductBrands, getCars, getBranches };
