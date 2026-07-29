const easyGasSyncService = require('./easyGasSyncService');

const SWEEP_INTERVAL_MS = parseInt(process.env.EASYGAS_SYNC_INTERVAL_MS, 10) || 30_000;
const BATCH_SIZE = 10;
const STALE_CLAIM_MINUTES = 5;

/**
 * Recovers rows stuck in SYNCING because a worker crashed (or was killed by
 * PM2) mid-push, before the outcome could be written back. Runs at the
 * start of every sweep cycle, on every worker — idempotent (a row already
 * back to PENDING or genuinely still mid-push within the window is untouched).
 */
const reapStaleClaims = async (pool) => {
  await pool.execute(
    `UPDATE warranty_forms SET easygas_sync_status = 'PENDING'
     WHERE easygas_sync_status = 'SYNCING'
       AND easygas_sync_claimed_at < DATE_SUB(NOW(), INTERVAL ${STALE_CLAIM_MINUTES} MINUTE)`
  );
};

/**
 * PM2 runs this app in cluster mode (multiple worker processes, each with
 * its own timer) — an atomic claim per row is what prevents two workers
 * from pushing the same warranty at once. `affectedRows === 1` is the only
 * signal that matters; a 0 means another worker (or a concurrent claim
 * attempt) already took it.
 */
const claimWarranty = async (pool, warrantyId) => {
  const [result] = await pool.execute(
    `UPDATE warranty_forms
     SET easygas_sync_status = 'SYNCING', easygas_sync_claimed_at = NOW(),
         easygas_sync_attempts = easygas_sync_attempts + 1
     WHERE id = ? AND easygas_sync_status = 'PENDING'
     LIMIT 1`,
    [warrantyId]
  );
  return result.affectedRows === 1;
};

const applyOutcome = async (pool, warrantyId, outcome) => {
  if (outcome.outcome === 'success') {
    await pool.execute(
      `UPDATE warranty_forms
       SET easygas_sync_status = 'SYNCED', easygas_synced_at = NOW(),
           easygas_warranty_number = ?, warranty_book_number = ?, easygas_last_error = NULL
       WHERE id = ?`,
      [outcome.warrantyNumber, outcome.warrantyNumber, warrantyId]
    );
    return;
  }
  if (outcome.outcome === 'terminal') {
    await pool.execute(
      `UPDATE warranty_forms
       SET easygas_sync_status = 'FAILED', easygas_sync_terminal = TRUE, easygas_last_error = ?
       WHERE id = ?`,
      [outcome.message?.slice(0, 255) || 'Unknown terminal error', warrantyId]
    );
    // Manual Verification diagnostics — server-log only, never written into
    // easygas_last_error itself (the admin UI parses a leading "CODE:"
    // token out of that string; appending context here would risk breaking
    // that parsing for no benefit — see AdminWarrantyFormsModern.jsx). A
    // terminal EasyGas failure (e.g. SERIAL_UNKNOWN) on a warranty that has
    // an admin-APPROVED manual-verification row is far more likely to be
    // "EasyGas doesn't recognize this manually-approved serial" than a data
    // error elsewhere — logging that connection here is the whole fix asked
    // for: better traceability, no change to the sync protocol or payload.
    try {
      const [approvedRows] = await pool.execute(
        `SELECT equipment_type FROM warranty_equipment WHERE warranty_form_id = ? AND verification_status = 'APPROVED'`,
        [warrantyId]
      );
      if (approvedRows.length > 0) {
        const types = approvedRows.map((r) => r.equipment_type).join(', ');
        console.warn(
          `[EasyGas Sync] Warranty ${warrantyId} failed terminally (${outcome.message}) and has ${approvedRows.length} admin-APPROVED Manual Verification row(s) (${types}) — ` +
          'the failure may be EasyGas rejecting a manually-approved serial number it has no record of, not a genuine data error.'
        );
      }
    } catch (diagError) {
      // Diagnostics must never affect the actual sync outcome above, which
      // has already been written and returned successfully.
      console.error(`[EasyGas Sync] Manual Verification diagnostic lookup failed for warranty ${warrantyId}:`, diagError.message);
    }
    return;
  }
  // Retryable — back to PENDING for the next cycle; attempts were already
  // incremented at claim time. No attempt cap per the approved plan: an
  // EasyGas outage should keep quietly retrying rather than silently give up.
  await pool.execute(
    `UPDATE warranty_forms SET easygas_sync_status = 'PENDING', easygas_last_error = ? WHERE id = ?`,
    [outcome.message?.slice(0, 255) || 'Unknown retryable error', warrantyId]
  );
};

/** One row, fully isolated — a bug or unexpected throw here must never take
 * down the rest of the batch or the sweep interval itself. */
const processOne = async (pool, warrantyId) => {
  try {
    const claimed = await claimWarranty(pool, warrantyId);
    if (!claimed) return; // another worker got it first

    const outcome = await easyGasSyncService.syncWarranty(pool, warrantyId);
    await applyOutcome(pool, warrantyId, outcome);
  } catch (error) {
    console.error(`[EasyGas Sync] Unexpected error syncing warranty ${warrantyId}:`, error.message);
    // Best-effort: release the claim so it isn't stuck in SYNCING until the
    // staleness reap catches it. If even this fails, the reap still recovers
    // it within STALE_CLAIM_MINUTES — never let this catch block itself throw.
    try {
      await pool.execute(
        `UPDATE warranty_forms SET easygas_sync_status = 'PENDING' WHERE id = ? AND easygas_sync_status = 'SYNCING'`,
        [warrantyId]
      );
    } catch { /* the staleness reap will recover it */ }
  }
};

const runSweepCycle = async (pool) => {
  await reapStaleClaims(pool);

  // Manual Verification workflow: a warranty with any equipment row still
  // PENDING review must not sync until every such row is resolved — EasyGas
  // needs a complete, valid 4-equipment submission, and a row with no
  // claimed inventory item and no confirmed identity isn't one yet. This
  // needs no per-warranty flag on warranty_forms: eligibility is computed
  // directly from warranty_equipment's current state on every poll, so
  // there's nothing to keep in sync or forget to "unlock" — the moment the
  // last PENDING row is approved, the very next cycle picks the warranty up
  // with zero extra write (see warrantyService.updateWarrantyForm/
  // reviewManualVerification). A REJECTED row doesn't need its own clause
  // here — reviewManualVerification's reject branch already moves the whole
  // warranty to easygas_sync_status='FAILED' immediately, which the primary
  // WHERE clause below already excludes.
  const [candidates] = await pool.execute(
    `SELECT id FROM warranty_forms wf
     WHERE wf.easygas_sync_status = 'PENDING'
       AND NOT EXISTS (
         SELECT 1 FROM warranty_equipment we
         WHERE we.warranty_form_id = wf.id AND we.verification_status = 'PENDING'
       )
     ORDER BY wf.created_at ASC LIMIT ${BATCH_SIZE}`
  );

  for (const { id } of candidates) {
    await processOne(pool, id);
  }
};

/**
 * Starts the interval-based retry sweep — the only path that ever pushes a
 * warranty to EasyGas (see the plan: no fire-and-forget immediate push
 * after create/update, since this app crashes its entire PM2 worker on any
 * unhandled rejection — an inline post-response call is exactly the shape
 * of code most likely to produce one by accident). The outer `.catch` here
 * is the last line of defense: it must never let a rejection escape into
 * the event loop uncaught.
 */
const startEasyGasSyncSweep = (pool) => {
  setInterval(() => {
    runSweepCycle(pool).catch((error) => {
      console.error('[EasyGas Sync] Sweep cycle failed:', error.message);
    });
  }, SWEEP_INTERVAL_MS);
  console.log(`[EasyGas Sync] Retry sweep started (every ${SWEEP_INTERVAL_MS}ms)`);
};

module.exports = { startEasyGasSyncSweep, runSweepCycle };
