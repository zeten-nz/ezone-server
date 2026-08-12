const { buildSignedHeaders } = require('../utils/easyGasSigning');

// Same signed base URL/secret as the catalog client (see
// easyGasCatalogClient.js) — EasyGas's own request, one shared credential
// pair for both APIs. Unlike the catalog client, this URL is used as the
// complete endpoint, not a prefix with an appended path: confirmed against
// the real server (see the standalone test-easygas.js verification this
// client's contract was proven against) that EASYGAS_WARRANTY_API_BASE_URL
// is the full `.../api/integrations/warranty` URL, not a shared prefix.
const BASE_URL = process.env.EASYGAS_WARRANTY_API_BASE_URL;
const SHARED_SECRET = process.env.EASYGAS_SHARED_SECRET;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Pure HTTP client for EasyGas's warranty-submission API — never acquires
 * or holds a DB connection, never throws (same never-rejects contract as
 * easyGasCatalogClient.request, for the same reason: the caller must be
 * free to record a failure and move on, never crash the request that
 * triggered it).
 *
 * `rawBody` must already be the exact, single JSON.stringify() of the
 * payload — this function signs and sends that exact string unchanged,
 * never re-serializing it (the byte-level guarantee proven in
 * test-easygas.js: signed bytes === transmitted bytes).
 */
const submitWarranty = async (rawBody) => {
  if (!BASE_URL || !SHARED_SECRET) {
    return { ok: false, status: 0, data: null, networkError: true, errorMessage: 'EASYGAS_WARRANTY_API_BASE_URL/EASYGAS_SHARED_SECRET not configured' };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const signedHeaders = buildSignedHeaders(SHARED_SECRET, rawBody);
    const response = await fetch(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...signedHeaders },
      body: rawBody,
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

module.exports = { submitWarranty };
