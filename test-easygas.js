/**
 * STANDALONE, MANUAL-ONLY verification tool for the EasyGas (STAG)
 * Warranty API integration contract.
 *
 * This is NOT part of the application and is not wired into anything.
 * Nothing in controllers/, routes/, services/, repositories/, or dtos/
 * imports this file, and this file never imports any of them either — it
 * hand-builds one realistic sample payload from values read directly out
 * of the database (see the investigation this script was produced from).
 * Running it has zero effect on EZONE's own database, server, or runtime;
 * its only real-world effect is the one HTTP request it sends to EasyGas's
 * server, and only after two local, offline self-checks both pass.
 *
 * Usage:
 *   node test-easygas.js          — SAFE default: offline checks only
 *                                    (config, secret fingerprint, HMAC test
 *                                    vectors, payload build + signing
 *                                    diagnostics). Sends NOTHING.
 *   node test-easygas.js --send   — explicit opt-in: additionally performs
 *                                    the one real POST to EasyGas.
 *
 * Requires EASYGAS_WARRANTY_API_BASE_URL and EASYGAS_SHARED_SECRET — set
 * in ezone-server/.env (auto-loaded below) or exported in your shell.
 * Neither is hardcoded here, and the secret is never printed (only a
 * one-way SHA256 fingerprint).
 */

require('dotenv').config();
const crypto = require('crypto');

// Live network POST requires this explicit flag — see the gate in main().
const LIVE_SEND = process.argv.includes('--send');

const BASE_URL = process.env.EASYGAS_WARRANTY_API_BASE_URL;
const SHARED_SECRET = process.env.EASYGAS_SHARED_SECRET;
const REQUEST_TIMEOUT_MS = 15_000;

// Published by EasyGas — used only to self-check that the configured
// secret and this script's HMAC implementation are both correct, entirely
// offline, before any network activity happens.
const EXPECTED_SECRET_FINGERPRINT = 'fcef8f17b4ee0e97';
const OFFICIAL_TEST_VECTOR = {
  timestamp: 1700000000,
  body: '{"phone":"998901234567"}',
  expectedSignature: '49389dbf04c6437dcb208b7fb6e93d1abfef989a5d82dcdc2bee46bfc317fba4',
};

// GET counterpart of the vector above — EasyGas signs an empty GET body as
// `${timestamp}.` (trailing dot, empty string after it), not `${timestamp}`
// with no dot. This is what services/easyGasCatalogClient.js's GET-only
// client actually produces via utils/easyGasSigning.js's sign(secret,
// timestamp, '') — confirmed by direct inspection: sign() always builds
// `${timestamp}.${rawBody}`, so an empty rawBody naturally leaves the dot in
// place. This vector exists to prove that against EasyGas's own published
// value once a real secret is configured (this script's fingerprint gate
// below can't run for the catalog GET client itself, since that client has
// no standalone CLI entry point — this is the closest offline equivalent).
const OFFICIAL_GET_TEST_VECTOR = {
  timestamp: 1700000000,
  expectedSignature: '909580b93d2e9c2b896c80857fb56971354dec91ae0b01a66b72236e67db597f',
};

function printSection(title) {
  console.log('\n' + '='.repeat(50));
  console.log(title);
  console.log('='.repeat(50));
}

function assertConfig() {
  const missing = [];
  if (!BASE_URL) missing.push('EASYGAS_WARRANTY_API_BASE_URL');
  if (!SHARED_SECRET) missing.push('EASYGAS_SHARED_SECRET');
  if (missing.length > 0) {
    console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
    console.error('Set them in ezone-server/.env or export them before running this script.');
    process.exit(1);
  }
}

/**
 * PHASE 2 gate: confirms the configured secret is the one EasyGas actually
 * issued, without ever printing the secret itself. Catches exactly the
 * failure mode this tool was built to catch — a wrong/placeholder secret
 * in .env — locally and instantly, instead of as an opaque 401 from a real
 * network round-trip.
 */
function verifySecretFingerprint() {
  const fingerprint = crypto.createHash('sha256').update(SHARED_SECRET, 'utf8').digest('hex').slice(0, 16);
  printSection('SECRET FINGERPRINT CHECK');
  console.log('SHA256(secret).slice(0,16):', fingerprint);
  console.log('Expected:                  ', EXPECTED_SECRET_FINGERPRINT);
  if (fingerprint !== EXPECTED_SECRET_FINGERPRINT) {
    console.error('\nSTOP: the configured EASYGAS_SHARED_SECRET does not match the known-correct secret.');
    console.error('Not sending anything. Fix EASYGAS_SHARED_SECRET (in .env or your shell) and re-run.');
    process.exit(1);
  }
  console.log('MATCH — secret confirmed correct.');
}

/**
 * PHASE 3 gate: proves this exact HMAC implementation reproduces EasyGas's
 * own published example before it's ever trusted against a real payload.
 */
function verifyOfficialTestVector() {
  const { timestamp, body, expectedSignature } = OFFICIAL_TEST_VECTOR;
  const produced = crypto.createHmac('sha256', SHARED_SECRET).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  printSection('OFFICIAL HMAC TEST VECTOR CHECK');
  console.log('timestamp:', timestamp);
  console.log('body:', body);
  console.log('Produced :', produced);
  console.log('Expected :', expectedSignature);
  if (produced !== expectedSignature) {
    console.error('\nSTOP: our HMAC implementation does not reproduce EasyGas\'s published example.');
    console.error('Not sending anything. Do not trust the request built below until this matches.');
    process.exit(1);
  }
  console.log('MATCH — HMAC implementation confirmed correct.');
}

/**
 * PHASE 3b gate: same idea as verifyOfficialTestVector above, but for a GET
 * request's empty-body signature — proves `${timestamp}.` (trailing dot,
 * nothing after it) is the correct base string, not `${timestamp}` alone.
 * Does not block this script's own POST send if it fails (this script never
 * makes a GET request), but a failure here means
 * services/easyGasCatalogClient.js's catalog GET requests would be signed
 * wrong — reported clearly rather than silently ignored.
 */
function verifyOfficialGetTestVector() {
  const { timestamp, expectedSignature } = OFFICIAL_GET_TEST_VECTOR;
  const produced = crypto.createHmac('sha256', SHARED_SECRET).update(`${timestamp}.`, 'utf8').digest('hex');
  printSection('OFFICIAL GET (EMPTY BODY) HMAC TEST VECTOR CHECK');
  console.log('timestamp:', timestamp);
  console.log('base string: "' + timestamp + '." (empty body after the dot)');
  console.log('Produced :', produced);
  console.log('Expected :', expectedSignature);
  if (produced !== expectedSignature) {
    console.warn('\nWARNING: GET signature does not match EasyGas\'s published example for this secret.');
    console.warn('Catalog sync (services/easyGasCatalogClient.js) would be signing GET requests incorrectly.');
  } else {
    console.log('MATCH — GET signature format confirmed correct.');
  }
}

/**
 * One realistic sample warranty. Installer/branch/product values are real,
 * read directly from the database (not invented) — see the accompanying
 * investigation: installer id=4 "Faridun Nazarov" is genuinely assigned to
 * branch "01/1" (EASY GAS SERVICE MCHJ); the three catalog product_ids
 * (251/215/240) are real products.external_id values for a real REDUCER,
 * CONTROLLER, and INJECTOR_RAIL product respectively. Only VIN, owner,
 * plate, submission_uuid, and external_ref are fabricated, per spec — this
 * must never carry real customer PII since it's sent to an external third
 * party purely as a contract test, not a real submission.
 */
function buildSamplePayload() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  return {
    submission_uuid: crypto.randomUUID(),
    warranty_book_number: 'W-2026-TEST999',
    branch_stag_code: '01/1',
    fuel_type: 'lpg',
    installer_full_name: 'Faridun Nazarov',
    organization_name: '01/1 EASY GAS SERVICE MCHJ',
    organization_phone: '+998 98 302 28 44',
    installation_date: today,
    region: 'Toshkent shahar',
    city: 'Toshkent',
    district: 'Sergeli',
    car_id: null,
    vehicle_brand: 'Chevrolet',
    vehicle_model: 'Cobalt',
    vehicle_production_year: 2021,
    vehicle_vin: 'TESTVIN0000012345',
    vehicle_mileage: 41230,
    vehicle_plate_number: '01A777AA',
    owner_full_name: 'Test Ownerov',
    owner_phone: '+998900000000',
    components: [
      { component_type: 'reducer', product_id: 251, serial_number: 'TESTRED0001' },
      { component_type: 'controller', product_id: 215, serial_number: 'TESTCTRL0001' },
      { component_type: 'injector', product_id: 240, serial_number: 'TESTINJ0001' },
      { component_type: 'cylinder', brand_name: 'GZWM', model: '60L Toroidal', serial_number: 'TESTCYL0001' },
    ],
    external_ref: 'EZONE-TEST-' + Date.now(),
  };
}

// Status-specific interpretation only — the raw status/headers/body are
// always printed first and in full; this is an addition, never a
// replacement, and never hides anything.
const STATUS_NOTES = {
  200: 'OK — likely a duplicate submission_uuid; EasyGas returned the existing record.',
  201: 'Created — new warranty accepted.',
  400: 'Bad Request — validation error. Check the response body above for which field.',
  401: 'Unauthorized — signature missing or invalid despite passing our local checks. Re-verify the base string/timestamp EasyGas actually received matches what we signed.',
  403: 'Forbidden — signature valid but not authorized for this branch_stag_code/secret.',
  404: 'Not Found — check EASYGAS_WARRANTY_API_BASE_URL is correct.',
  409: 'Conflict — submission_uuid reused with a different body.',
  422: 'Unprocessable Entity — well-formed JSON but failed semantic validation.',
  429: 'Too Many Requests — rate limited, retry later.',
  500: 'Internal Server Error — on EasyGas\'s side, not ours.',
};

async function main() {
  assertConfig();
  verifySecretFingerprint();
  verifyOfficialTestVector();
  verifyOfficialGetTestVector();

  const payload = buildSamplePayload();
  // Serialized EXACTLY ONCE, right here. Every downstream use (signing,
  // the actual request body) reuses this exact string — never re-derived
  // from `payload` again anywhere below, and `payload` itself is never
  // passed to fetch.
  const rawBody = JSON.stringify(payload);

  const timestamp = Math.floor(Date.now() / 1000);
  const signatureHex = crypto.createHmac('sha256', SHARED_SECRET).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  const signature = `sha256=${signatureHex}`;
  const secretFingerprint = crypto.createHash('sha256').update(SHARED_SECRET, 'utf8').digest('hex').slice(0, 16);

  const headers = {
    'Content-Type': 'application/json',
    'X-EG-Timestamp': String(timestamp),
    'X-EG-Signature': signature,
  };

  printSection('PRE-SEND DIAGNOSTICS');
  console.log('timestamp:', timestamp, `(${new Date(timestamp * 1000).toISOString()})`);
  console.log('rawBody.length:', rawBody.length);
  console.log('Buffer.byteLength(rawBody):', Buffer.byteLength(rawBody, 'utf8'));
  console.log('SHA256(rawBody):', crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex'));
  console.log('Signature:', signature);
  console.log('Secret fingerprint:', secretFingerprint);

  printSection('REQUEST');
  console.log('URL:', BASE_URL);
  console.log('Method: POST');
  console.log('Headers:', JSON.stringify(headers, null, 2));
  console.log('Body:', rawBody);

  // SAFE BY DEFAULT: everything above is offline (config check, secret
  // fingerprint, HMAC vectors, payload construction, signing diagnostics).
  // The actual network POST below only fires with an explicit --send flag —
  // a casual `node test-easygas.js` on a machine with real credentials
  // configured must never submit a real warranty to EasyGas by accident.
  if (!LIVE_SEND) {
    printSection('DRY RUN — NO REQUEST SENT');
    console.log('All offline checks completed. Nothing was transmitted to EasyGas.');
    console.log('To actually send the request above, re-run with the explicit flag:');
    console.log('\n  node test-easygas.js --send\n');
    return;
  }

  printSection('!!! LIVE REQUEST — SENDING TO EASYGAS NOW !!!');

  let response;
  try {
    response = await fetch(BASE_URL, {
      method: 'POST',
      headers,
      body: rawBody, // the exact same string that was signed — fetch sends it verbatim, never re-serializes payload
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (networkError) {
    printSection('NETWORK ERROR — no response received');
    if (networkError.name === 'TimeoutError') {
      console.error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms.`);
    } else if (networkError.cause?.code === 'ENOTFOUND') {
      console.error('DNS lookup failed — could not resolve the host in EASYGAS_WARRANTY_API_BASE_URL.');
    } else if (networkError.cause?.code === 'ECONNREFUSED') {
      console.error('Connection refused — nothing is listening at that host/port.');
    } else if (networkError.cause?.code?.startsWith('ERR_TLS') || networkError.cause?.code === 'CERT_HAS_EXPIRED') {
      console.error('TLS/certificate error:', networkError.cause.code);
    } else {
      console.error('Request failed before a response was received.');
    }
    console.error(networkError);
    process.exitCode = 1;
    return;
  }

  const rawResponseText = await response.text();
  let prettyResponseBody;
  try {
    prettyResponseBody = rawResponseText ? JSON.parse(rawResponseText) : null;
  } catch {
    prettyResponseBody = null; // not JSON — raw text above is the only representation
  }

  printSection('RESPONSE');
  console.log('Status:', response.status, response.statusText);
  console.log('Headers:');
  for (const [key, value] of response.headers.entries()) console.log(`  ${key}: ${value}`);
  console.log('\nRaw response:');
  console.log(rawResponseText);
  if (prettyResponseBody !== null) {
    console.log('\nPretty response:');
    console.log(JSON.stringify(prettyResponseBody, null, 2));
  }

  if (STATUS_NOTES[response.status]) {
    console.log(`\nInterpretation: ${STATUS_NOTES[response.status]}`);
  } else {
    console.log(`\nInterpretation: unexpected status ${response.status} — not one of the documented cases.`);
  }

  if (response.ok && prettyResponseBody?.warranty?.claim_url) {
    printSection('CLAIM URL');
    console.log('Warranty Number:', prettyResponseBody.warranty.warranty_book_number);
    console.log('Claim URL:', prettyResponseBody.warranty.claim_url);
    console.log('\nOpen this URL in a browser to verify that the QR destination is valid.');
  }

  if (!response.ok) process.exitCode = 1;
}

main();
