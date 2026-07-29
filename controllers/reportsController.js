const { pool } = require('../config/database');
const AppError = require('../utils/AppError');
const inventoryRepository = require('../repositories/inventoryRepository');
const inventoryImportBatchRepository = require('../repositories/inventoryImportBatchRepository');
const pointTransactionRepository = require('../repositories/pointTransactionRepository');

const sendAppError = (res, error) => {
  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    errorCode: error.errorCode,
    timestamp: new Date().toISOString(),
  });
};

const getDateRangeFilter = (days) => {
  if (!days || days === 'all') return null;
  const date = new Date();
  date.setDate(date.getDate() - parseInt(days, 10));
  return date.toISOString().split('T')[0];
};

/**
 * Ranks installers by warranty count — a different, equally legitimate
 * ranking from the real points leaderboard (getPointsLeaderboard, below):
 * "most warranties submitted" and "most points earned" can disagree (few
 * high-value installs vs. many low-value ones), so this stays as its own
 * report rather than being folded into or replaced by the points one (see
 * the Phase 4 plan's Critical Review #7). The date condition lives in the
 * LEFT JOIN's ON clause, not a WHERE clause, so employees with zero forms in
 * the period still appear in the result (at 0), instead of a WHERE filter
 * silently dropping them (effectively turning this into an INNER JOIN).
 */
const getTopInstallers = async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const dateFilter = getDateRangeFilter(req.query.period);

    const connection = await pool.getConnection();

    const params = [];
    let dateCondition = '';
    if (dateFilter) {
      dateCondition = 'AND wf.installation_date >= ?';
      params.push(dateFilter);
    }

    const [rows] = await connection.execute(
      `SELECT u.id AS employee_id, u.full_name AS employee_name, u.branch_id,
              b.name AS branch_name,
              COUNT(DISTINCT wf.id) AS warranty_count
       FROM users u
       LEFT JOIN branches b ON u.branch_id = b.id
       LEFT JOIN warranty_forms wf ON wf.employee_id = u.id ${dateCondition}
       WHERE u.role = 'EMPLOYEE'
       GROUP BY u.id, u.full_name, u.branch_id, b.name
       ORDER BY warranty_count DESC
       LIMIT ${limit}`,
      params
    );

    connection.release();
    res.json(rows);
  } catch (error) {
    next(error);
  }
};

/** Warranty-count series only — see getTopInstallers for why there's no
 * points column yet. */
const getMonthlyActivity = async (req, res, next) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const { employeeId } = req.query;

    const connection = await pool.getConnection();

    const conditions = ['YEAR(wf.installation_date) = ?'];
    const params = [year];
    if (employeeId) {
      conditions.push('wf.employee_id = ?');
      params.push(employeeId);
    }

    const [rows] = await connection.execute(
      `SELECT MONTH(wf.installation_date) AS month,
              COUNT(DISTINCT wf.id) AS warranty_count
       FROM warranty_forms wf
       WHERE ${conditions.join(' AND ')}
       GROUP BY MONTH(wf.installation_date)`,
      params
    );

    connection.release();

    // Fill in every month so the frontend gets a continuous 12-point series
    // (MySQL only returns rows that have data).
    const byMonth = new Map(rows.map((r) => [r.month, r]));
    const months = Array.from({ length: 12 }, (_, i) => {
      const month = i + 1;
      const row = byMonth.get(month);
      return {
        month,
        warranty_count: row?.warranty_count || 0,
      };
    });

    res.json({ year, months });
  } catch (error) {
    next(error);
  }
};

/** Counts grouped by category/brand, sourced from warranty_equipment (the
 * fixed 4-slot model) — every row here used to be an installation by
 * definition (unlike the old serialized-inventory model's 'INSTALLED'
 * check), but Manual Verification introduced two exceptions: a PENDING row
 * is not yet a confirmed installation, and a REJECTED row is a deliberate
 * "this wasn't a real/verified installation" decision — both excluded here
 * so this count reflects confirmed installations only, same as it always
 * intended to. AUTO (the ordinary barcode path) and APPROVED (an
 * admin-confirmed Manual Verification claim) both still count normally. */
const getProductsInstalled = async (req, res, next) => {
  try {
    const { category } = req.query;
    const connection = await pool.getConnection();

    const conditions = [`we.verification_status NOT IN ('PENDING', 'REJECTED')`];
    const params = [];
    if (category) {
      conditions.push('p.category = ?');
      params.push(category);
    }

    const [rows] = await connection.execute(
      `SELECT p.category, p.brand, COUNT(*) AS count
       FROM warranty_equipment we
       JOIN products p ON p.id = we.product_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY p.category, p.brand
       ORDER BY count DESC`,
      params
    );

    connection.release();
    res.json(rows);
  } catch (error) {
    next(error);
  }
};

const getBranchRanking = async (req, res, next) => {
  try {
    const dateFilter = getDateRangeFilter(req.query.period);
    const connection = await pool.getConnection();

    const params = [];
    let dateCondition = '';
    if (dateFilter) {
      dateCondition = 'AND wf.installation_date >= ?';
      params.push(dateFilter);
    }

    const [rows] = await connection.execute(
      `SELECT b.id AS branch_id, b.name AS branch_name, b.code AS branch_code,
              COUNT(DISTINCT wf.id) AS warranty_count
       FROM branches b
       LEFT JOIN users u ON u.branch_id = b.id
       LEFT JOIN warranty_forms wf ON wf.employee_id = u.id ${dateCondition}
       GROUP BY b.id, b.name, b.code
       ORDER BY warranty_count DESC`,
      params
    );

    connection.release();
    res.json(rows);
  } catch (error) {
    next(error);
  }
};

/**
 * Reports Dashboard totals (Phase 4) — every figure aggregated in SQL, no
 * in-JS row-counting of a full result set. Inventory status breakdown
 * excludes MERGED from every summed total (a merged duplicate is the same
 * physical unit as its canonical item — see the Phase 4 plan's D4) but the
 * per-status breakdown itself still reports it as its own bucket for admins
 * auditing past merges.
 */
// Shared by the JSON endpoint (getDashboardTotals) and the CSV export
// (exportCsvController.exportReports) — one source of truth for what
// "the dashboard totals" means, computed on a caller-supplied connection.
const getDashboardTotalsData = async (connection) => {
  const [[{ totalProducts }]] = await connection.execute('SELECT COUNT(*) AS totalProducts FROM products');
  const [[{ totalWarranties }]] = await connection.execute('SELECT COUNT(*) AS totalWarranties FROM warranty_forms');
  const statusBreakdown = await inventoryRepository.getStatusBreakdown(connection);
  const importedCounts = await inventoryRepository.getImportedCounts(connection);

  const byStatus = Object.fromEntries(statusBreakdown.map((r) => [r.status, Number(r.count)]));
  const totalInventory = statusBreakdown
    .filter((r) => r.status !== 'MERGED')
    .reduce((sum, r) => sum + Number(r.count), 0);

  // Success % excludes legacy pre-EasyGas warranties (submission_uuid IS
  // NULL, bulk-marked FAILED by a one-time backfill that never represented
  // a real attempted sync) — including them would permanently and
  // misleadingly deflate the metric with historical data, not real
  // installer/sync performance (Critical Review #3).
  const [[syncCounts]] = await connection.execute(
    `SELECT
       SUM(CASE WHEN easygas_sync_status = 'SYNCED' THEN 1 ELSE 0 END) AS synced,
       SUM(CASE WHEN easygas_sync_status = 'FAILED' AND easygas_sync_terminal = TRUE THEN 1 ELSE 0 END) AS failed
     FROM warranty_forms WHERE submission_uuid IS NOT NULL`
  );
  const attempted = Number(syncCounts.synced || 0) + Number(syncCounts.failed || 0);
  const successRate = attempted > 0 ? Number(syncCounts.synced) / attempted : null;

  return {
    totalProducts,
    totalInventory,
    installedProducts: byStatus.INSTALLED || 0,
    availableInventory: byStatus.IN_STOCK || 0,
    damagedInventory: byStatus.DAMAGED || 0,
    lostInventory: byStatus.LOST || 0,
    returnedInventory: byStatus.RETURNED || 0,
    importedToday: importedCounts.today,
    importedThisMonth: importedCounts.thisMonth,
    warrantyCount: totalWarranties,
    warrantySuccessRate: successRate,
  };
};

const getDashboardTotals = async (req, res, next) => {
  try {
    const connection = await pool.getConnection();
    try {
      const data = await getDashboardTotalsData(connection);
      connection.release();
      res.json(data);
    } catch (error) {
      connection.release();
      throw error;
    }
  } catch (error) {
    next(error);
  }
};

/**
 * Points Leaderboard — a new, separate report from getTopInstallers (see
 * that function's doc comment). period=month scopes to the current
 * calendar month; anything else (or omitted) is lifetime.
 */
const getPointsLeaderboard = async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    let since = null;
    if (req.query.period === 'month') {
      const now = new Date();
      since = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    }

    const connection = await pool.getConnection();
    const rows = await pointTransactionRepository.getLeaderboard(connection, { limit, since });
    connection.release();
    res.json(rows);
  } catch (error) {
    next(error);
  }
};

/** Top branches ("warehouses") by current inventory stock — a different
 * ranking from getBranchRanking (which ranks by warranty count). */
const getTopWarehouses = async (req, res, next) => {
  try {
    const connection = await pool.getConnection();
    const rows = await inventoryRepository.getBranchStockBreakdown(connection);
    connection.release();
    res.json(rows.filter((r) => r.branch_id != null).slice(0, 10));
  } catch (error) {
    next(error);
  }
};

const getRecentImports = async (req, res, next) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const connection = await pool.getConnection();
    const { rows } = await inventoryImportBatchRepository.findAllPaginated(connection, { page: 1, limit });
    connection.release();
    res.json(rows);
  } catch (error) {
    next(error);
  }
};

const getRecentWarrantyActivity = async (req, res, next) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const connection = await pool.getConnection();
    const [rows] = await connection.execute(
      `SELECT wf.id, wf.owner_full_name, wf.vehicle_name, wf.installation_date, wf.easygas_sync_status,
              wf.created_at, u.full_name AS employee_name
       FROM warranty_forms wf
       JOIN users u ON u.id = wf.employee_id
       ORDER BY wf.created_at DESC, wf.id DESC
       LIMIT ${limit}`
    );
    connection.release();
    res.json(rows);
  } catch (error) {
    next(error);
  }
};

const getRecentInventoryActivity = async (req, res, next) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const connection = await pool.getConnection();
    const rows = await inventoryRepository.getRecentActivity(connection, { limit });
    connection.release();
    res.json(rows);
  } catch (error) {
    next(error);
  }
};

/**
 * Shared by both the admin drill-down (getInstallerStatistics) and the
 * self-service endpoint (getMyStatistics) — mirrors pointsService's
 * getInstallerLedger reuse pattern from Phase 3. "Successful"/"Rejected"
 * installs map onto EasyGas sync outcome (the only real signal that exists
 * — see Critical Review #3), excluding legacy pre-integration rows from
 * both counts entirely, same reasoning as the dashboard's success rate.
 */
const getInstallerStatisticsData = async (connection, installerId) => {
  const [[counts]] = await connection.execute(
    `SELECT
       COUNT(*) AS totalWarranties,
       SUM(CASE WHEN submission_uuid IS NOT NULL AND easygas_sync_status = 'SYNCED' THEN 1 ELSE 0 END) AS successfulInstalls,
       SUM(CASE WHEN submission_uuid IS NOT NULL AND easygas_sync_status = 'FAILED' AND easygas_sync_terminal = TRUE THEN 1 ELSE 0 END) AS rejectedInstalls
     FROM warranty_forms WHERE employee_id = ?`,
    [installerId]
  );
  const [[claimed]] = await connection.execute(
    `SELECT COUNT(*) AS totalClaimedInventory
     FROM warranty_equipment we
     JOIN warranty_forms wf ON wf.id = we.warranty_form_id
     WHERE wf.employee_id = ? AND we.inventory_item_id IS NOT NULL`,
    [installerId]
  );
  // Manual Verification: excludes PENDING (not yet confirmed) and REJECTED
  // (explicitly not a verified installation) rows, same reasoning as
  // reportsController.getProductsInstalled — an installer's "top products"
  // should reflect confirmed installations, not unresolved or rejected claims.
  const [topProducts] = await connection.execute(
    `SELECT p.id, p.brand, p.model, COUNT(*) AS count
     FROM warranty_equipment we
     JOIN warranty_forms wf ON wf.id = we.warranty_form_id
     JOIN products p ON p.id = we.product_id
     WHERE wf.employee_id = ? AND we.verification_status NOT IN ('PENDING', 'REJECTED')
     GROUP BY p.id, p.brand, p.model
     ORDER BY count DESC LIMIT 10`,
    [installerId]
  );
  const [activity] = await connection.execute(
    `SELECT MONTH(installation_date) AS month, COUNT(DISTINCT id) AS warranty_count
     FROM warranty_forms
     WHERE employee_id = ? AND YEAR(installation_date) = YEAR(CURDATE())
     GROUP BY MONTH(installation_date)`,
    [installerId]
  );
  const byMonth = new Map(activity.map((r) => [r.month, r.warranty_count]));
  const activityGraph = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, warranty_count: byMonth.get(i + 1) || 0 }));

  // mysql2 returns SUM()/COALESCE(SUM()...) results as strings (MySQL's
  // wire protocol types them DECIMAL, not INT) — coerce to real numbers so
  // this API's numeric fields are consistently typed, matching
  // successfulInstalls/rejectedInstalls above.
  const [lifetimePoints, monthlyPoints] = await Promise.all([
    pointTransactionRepository.getInstallerTotal(connection, installerId),
    pointTransactionRepository.getMonthlyTotal(connection, installerId),
  ]);
  const lifetimePointsNum = Number(lifetimePoints) || 0;
  const monthlyPointsNum = Number(monthlyPoints) || 0;

  return {
    totalWarranties: counts.totalWarranties,
    totalClaimedInventory: claimed.totalClaimedInventory,
    successfulInstalls: Number(counts.successfulInstalls) || 0,
    rejectedInstalls: Number(counts.rejectedInstalls) || 0,
    currentPoints: lifetimePointsNum,
    lifetimePoints: lifetimePointsNum,
    monthlyPoints: monthlyPointsNum,
    topInstalledProducts: topProducts,
    activityGraph,
  };
};

const getInstallerStatistics = async (req, res, next) => {
  try {
    const connection = await pool.getConnection();
    const data = await getInstallerStatisticsData(connection, req.params.installerId);
    connection.release();
    res.json(data);
  } catch (error) {
    next(error);
  }
};

// Always the authenticated user's own id — never accept an installerId from
// query params, same "/mine"-shaped pattern as GET /points/mine.
const getMyStatistics = async (req, res, next) => {
  try {
    const connection = await pool.getConnection();
    const data = await getInstallerStatisticsData(connection, req.user.id);
    connection.release();
    res.json(data);
  } catch (error) {
    next(error);
  }
};

const getProductStatistics = async (req, res, next) => {
  try {
    const connection = await pool.getConnection();
    const { counts, topInstallers, topBranches } = await inventoryRepository.getProductStatistics(connection, req.params.productId);
    connection.release();

    const imported = Number(counts.imported) || 0;
    const damaged = Number(counts.damaged) || 0;
    const returned = Number(counts.returned) || 0;

    res.json({
      importedQuantity: imported,
      installedQuantity: Number(counts.installed) || 0,
      remainingStock: Number(counts.remaining) || 0,
      failureRate: imported > 0 ? damaged / imported : 0,
      returnRate: imported > 0 ? returned / imported : 0,
      topInstallers,
      topBranches,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * One row per real installer (role='EMPLOYEE') — the bulk/export shape of
 * getInstallerStatisticsData, computed as aggregate GROUP BY queries rather
 * than looping the single-installer function per installer (which would be
 * N+1 queries against a live DB — the exact anti-pattern the Phase 4 plan's
 * Performance section rules out). Used by the CSV export only; the
 * per-installer detail page still uses getInstallerStatisticsData.
 */
const getAllInstallersStatisticsData = async (connection) => {
  const [warrantyRows] = await connection.execute(
    `SELECT u.id, u.full_name,
            COUNT(wf.id) AS totalWarranties,
            SUM(CASE WHEN wf.submission_uuid IS NOT NULL AND wf.easygas_sync_status = 'SYNCED' THEN 1 ELSE 0 END) AS successfulInstalls,
            SUM(CASE WHEN wf.submission_uuid IS NOT NULL AND wf.easygas_sync_status = 'FAILED' AND wf.easygas_sync_terminal = TRUE THEN 1 ELSE 0 END) AS rejectedInstalls
     FROM users u
     LEFT JOIN warranty_forms wf ON wf.employee_id = u.id
     WHERE u.role = 'EMPLOYEE'
     GROUP BY u.id, u.full_name`
  );
  // getLeaderboard's total is also a mysql2 SUM() string — coerce here too.
  const pointsByInstaller = new Map(
    (await pointTransactionRepository.getLeaderboard(connection, { limit: 100000 })).map((r) => [r.installer_id, Number(r.total) || 0])
  );
  return warrantyRows.map((r) => ({
    id: r.id,
    full_name: r.full_name,
    totalWarranties: r.totalWarranties,
    successfulInstalls: Number(r.successfulInstalls) || 0,
    rejectedInstalls: Number(r.rejectedInstalls) || 0,
    lifetimePoints: pointsByInstaller.get(r.id) ?? 0,
  }));
};

/** One row per product — the bulk/export shape of
 * inventoryRepository.getProductStatistics, aggregated in one query rather
 * than looping per product. */
const getAllProductsStatisticsData = async (connection) => {
  const [rows] = await connection.execute(
    `SELECT p.id, p.brand, p.model,
            COUNT(i.id) AS imported,
            SUM(CASE WHEN i.status = 'INSTALLED' THEN 1 ELSE 0 END) AS installed,
            SUM(CASE WHEN i.status = 'IN_STOCK' THEN 1 ELSE 0 END) AS remaining,
            SUM(CASE WHEN i.status = 'DAMAGED' THEN 1 ELSE 0 END) AS damaged,
            SUM(CASE WHEN i.status = 'RETURNED' THEN 1 ELSE 0 END) AS returned
     FROM products p
     LEFT JOIN inventory_items i ON i.product_id = p.id AND i.status != 'MERGED'
     GROUP BY p.id, p.brand, p.model`
  );
  return rows.map((r) => {
    const imported = Number(r.imported) || 0;
    return {
      id: r.id,
      brand: r.brand,
      model: r.model,
      imported,
      installed: Number(r.installed) || 0,
      remaining: Number(r.remaining) || 0,
      failureRate: imported > 0 ? Number(r.damaged) / imported : 0,
      returnRate: imported > 0 ? Number(r.returned) / imported : 0,
    };
  });
};

const getWarehouseStatistics = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const connection = await pool.getConnection();
    const [[branch]] = await connection.execute('SELECT id FROM branches WHERE id = ?', [branchId]);
    if (!branch) {
      connection.release();
      throw new AppError('Warehouse not found', 404, 'NOT_FOUND');
    }

    const breakdown = await inventoryRepository.getBranchStockBreakdown(connection, { branchId });
    const movementHistory = await inventoryRepository.getRecentActivity(connection, { limit: 20, branchId });
    connection.release();

    // A real branch legitimately having zero inventory assigned to it yet
    // is a normal state, not a "not found" — only the branch's own
    // existence (checked above) gates the 404. Zero-stock warehouses get an
    // honest all-zero response, not a fabricated non-error and not a
    // misleading 404 (see the standing "no fake dashboard data" rule).
    const stats = breakdown[0] || { in_stock: 0, installed: 0, reserved: 0, damaged: 0, returned: 0, lost: 0 };
    res.json({
      currentStock: Number(stats.in_stock) || 0,
      installedStock: Number(stats.installed) || 0,
      reservedStock: Number(stats.reserved) || 0,
      damagedStock: Number(stats.damaged) || 0,
      returnedStock: Number(stats.returned) || 0,
      lostStock: Number(stats.lost) || 0,
      movementHistory,
    });
  } catch (error) {
    if (error instanceof AppError) {
      return sendAppError(res, error);
    }
    next(error);
  }
};

module.exports = {
  getTopInstallers,
  getMonthlyActivity,
  getProductsInstalled,
  getBranchRanking,
  getDashboardTotals,
  getDashboardTotalsData,
  getPointsLeaderboard,
  getTopWarehouses,
  getRecentImports,
  getRecentWarrantyActivity,
  getRecentInventoryActivity,
  getInstallerStatistics,
  getInstallerStatisticsData,
  getAllInstallersStatisticsData,
  getMyStatistics,
  getProductStatistics,
  getAllProductsStatisticsData,
  getWarehouseStatistics,
};
