/**
 * CSV export endpoints (Phase 4) — deliberately CSV + streamed, not the
 * existing XLSX-in-memory pattern (excelController.js): the user's explicit
 * requirement was "CSV must stream large datasets, do not load everything
 * into memory," a genuine, deliberate departure for these 7 endpoints
 * specifically (see the Phase 4 plan's D6). Inventory/warranty/points use
 * true keyset-paginated streaming (streamRowsAsCsv); reports/installer-
 * statistics/product-statistics/warehouse-statistics are inherently small,
 * aggregate-bounded (one row per installer/product/branch, not a row-level
 * table that can grow unbounded), so they use the single-pass writer
 * (writeRowsAsCsv) — same formatting/headers, no chunking overhead for a
 * dataset that's bounded by entity count, not warranty/inventory volume.
 *
 * Every export is localized via csvLabels.js, driven by the X-Language
 * header the frontend's axios client already attaches from LanguageContext
 * on every request — no per-endpoint language handling, one resolveLanguage()
 * call per function.
 */

const { pool } = require('../config/database');
const { streamRowsAsCsv, writeRowsAsCsv } = require('../utils/csvStream');
const { resolveLanguage, getLabels, translateEnum, formatCsvDate } = require('../config/csvLabels');
const inventoryRepository = require('../repositories/inventoryRepository');
const warrantyRepository = require('../repositories/warrantyRepository');
const pointTransactionRepository = require('../repositories/pointTransactionRepository');
const reportsController = require('./reportsController');
const { attachEquipment } = require('../utils/warrantyEquipment');
const { buildWarrantyColumns } = require('../utils/warrantyCsvColumns');

const dateStamp = () => new Date().toISOString().split('T')[0];

const exportInventory = async (req, res, next) => {
  let connection;
  try {
    const language = resolveLanguage(req);
    const labels = getLabels(language);
    connection = await pool.getConnection();
    await streamRowsAsCsv(res, {
      filename: `inventory_${dateStamp()}.csv`,
      columns: [
        { header: labels.columns.id, value: (r) => r.id },
        { header: labels.columns.barcode, value: (r) => r.barcode },
        { header: labels.columns.brand, value: (r) => r.brand },
        { header: labels.columns.model, value: (r) => r.model },
        { header: labels.columns.category, value: (r) => translateEnum(labels.categories, r.category) },
        { header: labels.columns.status, value: (r) => translateEnum(labels.inventoryStatuses, r.status) },
        { header: labels.columns.branch, value: (r) => r.branch_name || labels.unassigned },
        { header: labels.columns.importBatchId, value: (r) => r.import_batch_id },
        { header: labels.columns.createdAt, value: (r) => formatCsvDate(r.created_at, language, true) },
        { header: labels.columns.updatedAt, value: (r) => formatCsvDate(r.updated_at, language, true) },
      ],
      fetchChunk: (lastId, limit) => inventoryRepository.findChunkForExport(connection, { lastId, limit }),
    });
  } catch (error) {
    if (!res.headersSent) return next(error);
    res.end();
  } finally {
    if (connection) connection.release();
  }
};

const exportWarranty = async (req, res, next) => {
  let connection;
  try {
    const language = resolveLanguage(req);
    const labels = getLabels(language);
    // Same optional filters as the paginated list endpoint (getAllWarrantyForms)
    // — lets "export filtered results" actually export what's filtered,
    // instead of silently dumping the whole table.
    const employeeId = req.query.employeeId ? parseInt(req.query.employeeId, 10) : undefined;
    const search = (req.query.search || '').trim() || undefined;
    const verificationStatus = req.query.verificationStatus || undefined;
    connection = await pool.getConnection();
    await streamRowsAsCsv(res, {
      filename: `warranty_${dateStamp()}.csv`,
      // Full detail-view parity, incl. separate per-equipment product+serial columns (§9). Column set + per-slot
      // resolution live in utils/warrantyCsvColumns.js (unit-tested).
      columns: buildWarrantyColumns(labels, language),
      // Keyset pagination preserved: fetch one warranty chunk, then enrich it with ONE batched warranty_equipment
      // query (attachEquipment → equipmentRepository.findByWarrantyFormIds) — no N+1, memory stays O(chunk). Rows
      // still carry wf.id, so streamRowsAsCsv's keyset cursor is unaffected.
      fetchChunk: async (lastId, limit) => {
        const rows = await warrantyRepository.findChunkForExport(connection, { lastId, limit, employeeId, search, verificationStatus });
        return attachEquipment(connection, rows);
      },
    });
  } catch (error) {
    if (!res.headersSent) return next(error);
    res.end();
  } finally {
    if (connection) connection.release();
  }
};

// Super Admin only — matches the points ledger view's own gating precedent
// from Phase 3 (manual-adjustment-adjacent detail), same reasoning that
// scopes the /points/adjustments write endpoint.
const exportPoints = async (req, res, next) => {
  let connection;
  try {
    const language = resolveLanguage(req);
    const labels = getLabels(language);
    connection = await pool.getConnection();
    await streamRowsAsCsv(res, {
      filename: `points_${dateStamp()}.csv`,
      columns: [
        { header: labels.columns.id, value: (r) => r.id },
        { header: labels.columns.installer, value: (r) => r.installer_name },
        { header: labels.columns.points, value: (r) => r.points },
        { header: labels.columns.type, value: (r) => translateEnum(labels.transactionTypes, r.transaction_type) },
        { header: labels.columns.product, value: (r) => (r.product_brand ? `${r.product_brand} ${r.product_model || ''}`.trim() : '') },
        { header: labels.columns.reason, value: (r) => r.reason },
        { header: labels.columns.createdAt, value: (r) => formatCsvDate(r.created_at, language, true) },
      ],
      fetchChunk: (lastId, limit) => pointTransactionRepository.findChunkForExport(connection, { lastId, limit }),
    });
  } catch (error) {
    if (!res.headersSent) return next(error);
    res.end();
  } finally {
    if (connection) connection.release();
  }
};

const exportReports = async (req, res, next) => {
  let connection;
  try {
    const language = resolveLanguage(req);
    const labels = getLabels(language);
    connection = await pool.getConnection();
    const totals = await reportsController.getDashboardTotalsData(connection);
    connection.release();
    connection = null;

    writeRowsAsCsv(res, {
      filename: `reports_${dateStamp()}.csv`,
      columns: [
        { header: labels.columns.metric, value: (r) => r.metric },
        { header: labels.columns.value, value: (r) => r.value },
      ],
      rows: [
        { metric: labels.metrics.totalProducts, value: totals.totalProducts },
        { metric: labels.metrics.totalInventory, value: totals.totalInventory },
        { metric: labels.metrics.installedProducts, value: totals.installedProducts },
        { metric: labels.metrics.availableInventory, value: totals.availableInventory },
        { metric: labels.metrics.damagedInventory, value: totals.damagedInventory },
        { metric: labels.metrics.lostInventory, value: totals.lostInventory },
        { metric: labels.metrics.returnedInventory, value: totals.returnedInventory },
        { metric: labels.metrics.importedToday, value: totals.importedToday },
        { metric: labels.metrics.importedThisMonth, value: totals.importedThisMonth },
        { metric: labels.metrics.warrantyCount, value: totals.warrantyCount },
      ],
    });
  } catch (error) {
    if (connection) connection.release();
    if (!res.headersSent) return next(error);
    res.end();
  }
};

// Super Admin only — includes lifetime points per installer, the same
// manual-adjustment-adjacent detail that gates the points export above.
const exportInstallerStatistics = async (req, res, next) => {
  let connection;
  try {
    const language = resolveLanguage(req);
    const labels = getLabels(language);
    connection = await pool.getConnection();
    const rows = await reportsController.getAllInstallersStatisticsData(connection);
    connection.release();
    connection = null;

    writeRowsAsCsv(res, {
      filename: `installer_statistics_${dateStamp()}.csv`,
      columns: [
        { header: labels.columns.installer, value: (r) => r.full_name },
        { header: labels.columns.totalWarranties, value: (r) => r.totalWarranties },
        { header: labels.columns.lifetimePoints, value: (r) => r.lifetimePoints },
      ],
      rows,
    });
  } catch (error) {
    if (connection) connection.release();
    if (!res.headersSent) return next(error);
    res.end();
  }
};

const exportProductStatistics = async (req, res, next) => {
  let connection;
  try {
    const language = resolveLanguage(req);
    const labels = getLabels(language);
    connection = await pool.getConnection();
    const rows = await reportsController.getAllProductsStatisticsData(connection);
    connection.release();
    connection = null;

    writeRowsAsCsv(res, {
      filename: `product_statistics_${dateStamp()}.csv`,
      columns: [
        { header: labels.columns.product, value: (r) => `${r.brand} ${r.model || ''}`.trim() },
        { header: labels.columns.imported, value: (r) => r.imported },
        { header: labels.columns.installed, value: (r) => r.installed },
        { header: labels.columns.remainingStock, value: (r) => r.remaining },
        { header: labels.columns.failureRate, value: (r) => (r.failureRate * 100).toFixed(1) },
        { header: labels.columns.returnRate, value: (r) => (r.returnRate * 100).toFixed(1) },
      ],
      rows,
    });
  } catch (error) {
    if (connection) connection.release();
    if (!res.headersSent) return next(error);
    res.end();
  }
};

const exportWarehouseStatistics = async (req, res, next) => {
  let connection;
  try {
    const language = resolveLanguage(req);
    const labels = getLabels(language);
    connection = await pool.getConnection();
    const rows = await inventoryRepository.getBranchStockBreakdown(connection);
    connection.release();
    connection = null;

    writeRowsAsCsv(res, {
      filename: `warehouse_statistics_${dateStamp()}.csv`,
      columns: [
        { header: labels.columns.warehouse, value: (r) => r.branch_name || labels.unassigned },
        { header: labels.columns.total, value: (r) => r.total },
        { header: labels.columns.currentStock, value: (r) => r.in_stock },
        { header: labels.columns.installedStock, value: (r) => r.installed },
        { header: labels.columns.reservedStock, value: (r) => r.reserved },
        { header: labels.columns.damagedStock, value: (r) => r.damaged },
        { header: labels.columns.returnedStock, value: (r) => r.returned },
        { header: labels.columns.lostStock, value: (r) => r.lost },
      ],
      rows,
    });
  } catch (error) {
    if (connection) connection.release();
    if (!res.headersSent) return next(error);
    res.end();
  }
};

module.exports = {
  exportInventory,
  exportWarranty,
  exportPoints,
  exportReports,
  exportInstallerStatistics,
  exportProductStatistics,
  exportWarehouseStatistics,
};
