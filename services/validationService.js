/**
 * PLACEHOLDER — not wired into any real flow yet. Documents the future
 * integration point for the external STAG validation API: submitting a
 * serial number will eventually return { status: 'VALID'|'INVALID',
 * reward_points, transaction_id, response }, at which point warrantyService
 * would call this after a warranty is stored and persist the result onto
 * the corresponding warranty_equipment row. Until that's built, every row
 * stays PENDING/NULL — this stub is intentionally never called by any
 * controller or service today.
 */
const validateEquipment = async (_serialNumber) => ({ status: 'PENDING' });

module.exports = { validateEquipment };
