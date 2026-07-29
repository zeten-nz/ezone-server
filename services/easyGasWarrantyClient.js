const { buildSignedHeaders } = require('../utils/easyGasSigning');

// EasyGas's private, HMAC-signed warranty-submission API. The catalog API
// (see easyGasCatalogClient.js) now shares this same signed base URL/secret
// per EasyGas's request — both clients sign via utils/easyGasSigning.js.
const BASE_URL = process.env.EASYGAS_WARRANTY_API_BASE_URL;
const SHARED_SECRET = process.env.EASYGAS_SHARED_SECRET;
const REQUEST_TIMEOUT_MS = 3000;

/**
 * Pure HTTP client for EasyGas's private warranty-submission API — never
 * acquires or holds a DB connection. This function NEVER rejects — network
 * failures, timeouts, and JSON-parse failures all resolve to
 * `{ ok: false, networkError: true, ... }` instead of throwing, because the
 * only caller (the retry sweep, services/easyGasSyncSweep.js) runs in a
 * detached setInterval context where an uncaught rejection would trip
 * server.js's unhandledRejection handler and kill the entire PM2 worker.
 */
const request = async (method, path, body) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Everything from here down is inside this try, deliberately including
  // signing itself — e.g. a missing/misconfigured EASYGAS_SHARED_SECRET
  // (BASE_URL/SECRET are undefined until go-live, see .env.example) makes
  // crypto.createHmac throw synchronously, and since this is an async
  // function, a throw outside a try/catch here would still reject the
  // returned promise, silently breaking the "never rejects" contract this
  // whole client exists to provide.
  try {
    const rawBody = body ? JSON.stringify(body) : '';
    const signedHeaders = buildSignedHeaders(SHARED_SECRET, rawBody);

    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...signedHeaders,
      },
      body: method === 'GET' ? undefined : rawBody,
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

const submitWarranty = (payload) => request('POST', '', payload);

module.exports = { submitWarranty };
