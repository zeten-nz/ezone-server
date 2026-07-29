/**
 * Manual, one-off connectivity check for EasyGas's live HMAC-signed warranty
 * API — never invoked by the app, the sweep, or any HTTP route. Run by hand:
 *
 *   npm run easygas:test-connection
 *
 * Fires exactly one real signed POST through the exact production client
 * (services/easyGasWarrantyClient.js) with a synthetic, obviously-fake
 * payload — never a real customer's data — matching the CONFIRMED contract
 * (nested components array, organization_name/phone, car_id) rather than
 * guessed fields. Fake car_id/product_id/serials are expected to come back
 * as CAR_UNKNOWN/PRODUCT_UNKNOWN/SERIAL_UNKNOWN — that's fine, the point is
 * confirming the STRUCTURAL shape (organization_name, components, etc.) is
 * no longer rejected as missing/incomplete.
 */
require('dotenv').config();
const crypto = require('crypto');
const easyGasWarrantyClient = require('./services/easyGasWarrantyClient');
const { classifyResult } = require('./services/easyGasSyncService');

const FAKE_PAYLOAD = {
  submission_uuid: crypto.randomUUID(),
  external_ref: 0,
  branch_stag_code: null,
  fuel_type: 'lpg',
  installer_full_name: 'EZONE CONNECTIVITY TEST',
  organization_name: 'EZONE CONNECTIVITY TEST BRANCH',
  organization_phone: '+998900000000',
  installation_date: new Date().toISOString().slice(0, 10),
  region: 'Toshkent',
  city: 'Toshkent',
  district: 'Toshkent',
  car_id: 999999999,
  vehicle_production_year: 2020,
  vehicle_plate_number: 'TEST999',
  vehicle_vin: 'EZONETESTVIN0001',
  vehicle_mileage: 0,
  owner_full_name: 'EZONE CONNECTIVITY TEST',
  owner_phone: '+998900000000',
  components: [
    { component_type: 'reducer', product_id: 999999901, serial_number: 'EZONE-TEST-0001' },
    { component_type: 'cylinder', product_id: 999999902, serial_number: 'EZONE-TEST-0002' },
    { component_type: 'injector', product_id: 999999903, serial_number: 'EZONE-TEST-0003' },
    { component_type: 'controller', product_id: 999999904, serial_number: 'EZONE-TEST-0004' },
  ],
};

(async () => {
  console.log('BASE_URL:', process.env.EASYGAS_WARRANTY_API_BASE_URL || '(unset)');
  console.log('Secret configured:', Boolean(process.env.EASYGAS_SHARED_SECRET));

  const result = await easyGasWarrantyClient.submitWarranty(FAKE_PAYLOAD);

  console.log('\nHTTP status:', result.status, '| networkError:', result.networkError, result.errorMessage || '');
  console.log('Response body:', JSON.stringify(result.data, null, 2));
  console.log('\nclassifyResult() ->', classifyResult(result));

  process.exit(0);
})();
