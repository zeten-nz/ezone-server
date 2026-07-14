const { pool } = require('../config/database');

const getDateRangeFilter = (days) => {
  if (!days || days === 'all') return null;
  const date = new Date();
  date.setDate(date.getDate() - parseInt(days, 10));
  return date.toISOString().split('T')[0];
};

/**
 * Ranks installers by warranty count (not points — reward_points is a
 * future-only field, null until the external STAG validation API responds;
 * there's nothing real to sum yet). The date condition lives in the LEFT
 * JOIN's ON clause, not a WHERE clause, so employees with zero forms in the
 * period still appear in the result (at 0), instead of a WHERE filter
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
 * fixed 4-slot model) — every row here is by definition an installation, so
 * there's no status filter needed (unlike the old serialized-inventory
 * model's 'INSTALLED' check). */
const getProductsInstalled = async (req, res, next) => {
  try {
    const { category } = req.query;
    const connection = await pool.getConnection();

    const conditions = ['1 = 1'];
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

module.exports = {
  getTopInstallers,
  getMonthlyActivity,
  getProductsInstalled,
  getBranchRanking,
};
