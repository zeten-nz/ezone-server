/**
 * Runs `work()` inside its own transaction on `connection` and returns a
 * result object instead of throwing, so a caller can log a precise,
 * per-row failure and move on to the next row without the whole migration
 * step aborting.
 *
 * Deliberately one transaction PER ROW, not one shared transaction across
 * a batch of rows: this data set is a few hundred rows per table, spread
 * across independent tables with no relationship to each other within a
 * table (only products->brands crosses tables, and that's handled by
 * migrating brands to completion before products starts). Grouping
 * unrelated rows into a single transaction would only add risk — one bad
 * row rolling back its perfectly good neighbors — with no real benefit at
 * this volume. A transaction per row gives the strongest possible
 * isolation: a failure can never leave partial data, and it can never take
 * down a row that would otherwise have succeeded.
 */
async function withTransaction(connection, work) {
  await connection.beginTransaction();
  try {
    const result = await work();
    await connection.commit();
    return { ok: true, result };
  } catch (error) {
    await connection.rollback();
    return { ok: false, error };
  }
}

module.exports = { withTransaction };
