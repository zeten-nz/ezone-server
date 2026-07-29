const crypto = require('crypto');

/**
 * Shared HMAC-SHA256 request signing for both EasyGas API clients —
 * easyGasWarrantyClient.js and easyGasCatalogClient.js — which now live
 * behind the same signed base URL/secret per EasyGas's request. Extracted
 * out of easyGasWarrantyClient.js, which held this privately before the
 * catalog API also required signing.
 *
 * Signs the EXACT bytes about to be transmitted — `rawBody` must be the same
 * string used as the actual request body, never a second independent
 * JSON.stringify call (which could theoretically differ in key order). GET
 * requests sign an empty body: `${timestamp}.`.
 */
const sign = (secret, timestamp, rawBody) => {
  const payload = `${timestamp}.${rawBody}`;
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${hmac}`;
};

const buildSignedHeaders = (secret, rawBody) => {
  const timestamp = Math.floor(Date.now() / 1000);
  return { 'X-EG-Timestamp': String(timestamp), 'X-EG-Signature': sign(secret, timestamp, rawBody) };
};

module.exports = { sign, buildSignedHeaders };
