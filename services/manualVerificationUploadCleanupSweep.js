const fs = require('fs');
const path = require('path');
const manualVerificationUploadRepository = require('../repositories/manualVerificationUploadRepository');
const { MANUAL_VERIFICATION_UPLOAD_DIR } = require('../config/uploads');

// A lower-urgency interval than most sweeps — an abandoned upload sitting
// an extra hour costs nothing but disk space.
const SWEEP_INTERVAL_MS = parseInt(process.env.MANUAL_VERIFICATION_CLEANUP_INTERVAL_MS, 10) || 60 * 60_000; // 1 hour
// Matches the same 24-hour mental model already used elsewhere in this
// feature (the installer edit window) — not a hard requirement, just a
// generous grace period so an upload mid-form-fill is never swept out from
// under an installer who hasn't submitted yet.
const ORPHAN_GRACE_HOURS = 24;

/**
 * Deletes Manual Verification photo uploads that were never actually
 * attached to a warranty (see manualVerificationUploadRepository.findOrphaned
 * for the exact "orphaned" definition — a live NOT EXISTS check against
 * warranty_equipment, not a separately-maintained flag). One row, fully
 * isolated per file: a single bad unlink must never stop the rest of the
 * batch or the sweep interval itself.
 */
const runCleanupCycle = async (pool) => {
  const orphaned = await manualVerificationUploadRepository.findOrphaned(pool, ORPHAN_GRACE_HOURS);
  if (orphaned.length === 0) return;

  const cleanedIds = [];
  for (const { id, filename } of orphaned) {
    try {
      const safeName = path.basename(filename);
      await fs.promises.unlink(path.join(MANUAL_VERIFICATION_UPLOAD_DIR, safeName));
      cleanedIds.push(id);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Already gone from disk (manual cleanup, prior partial run) — the
        // tracking row is still stale and should go too.
        cleanedIds.push(id);
      } else {
        console.error(`[Manual Verification Cleanup] Failed to remove orphaned photo ${filename}:`, error.message);
      }
    }
  }

  if (cleanedIds.length > 0) {
    await manualVerificationUploadRepository.deleteByIds(pool, cleanedIds);
    console.log(`[Manual Verification Cleanup] Removed ${cleanedIds.length} orphaned upload(s)`);
  }
};

/**
 * Starts the interval-based orphan-upload cleanup. The outer `.catch` must
 * never let a rejection escape uncaught — this app crashes its whole PM2
 * worker on an unhandled rejection.
 */
const startManualVerificationUploadCleanupSweep = (pool) => {
  setInterval(() => {
    runCleanupCycle(pool).catch((error) => {
      console.error('[Manual Verification Cleanup] Cycle failed:', error.message);
    });
  }, SWEEP_INTERVAL_MS);
  console.log(`[Manual Verification Cleanup] Orphaned-upload sweep started (every ${SWEEP_INTERVAL_MS}ms, ${ORPHAN_GRACE_HOURS}h grace period)`);
};

module.exports = { startManualVerificationUploadCleanupSweep, runCleanupCycle };
