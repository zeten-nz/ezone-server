# 03 — Database

[← Back to index](01-project-overview.md)

Source: `ezone-server/config/database.js`, function `initializeDatabase()`, cross-checked directly against the live schema (`SHOW COLUMNS`) rather than re-derived purely from migration history, so this reflects the actual current state, not just the intended one. Unless a foreign key explicitly states an `ON DELETE` behavior, MySQL's default is **RESTRICT**.

Status tags: **Live** (actively written/read), **Legacy** (superseded, kept for historical display only), **Dormant** (schema exists, nothing populates it yet, but a real future use is intended), **Dead** (superseded, no known future use, safe to ignore — kept only because migrations never drop columns).

## Core Identity

### `users` — Live
`id, full_name, first_name, last_name, username (UNIQUE), password, phone, region, district, branch_code (legacy free-text), branch_id → branches.id (RESTRICT), photo_filename, role ENUM('ADMIN','EMPLOYEE') DEFAULT 'EMPLOYEE', is_super_admin BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE, last_login_at, created_at, updated_at`.

`is_super_admin` is an **additive flag on top of ADMIN, not a third role**. `is_active` gates login and is re-checked live on every request (see [04-backend.md](04-backend.md)).

### `branches` — Live
`id, code (UNIQUE, immutable after creation), easygas_stag_code VARCHAR(20) NULL, name, phone, region, district, city, is_active, created_at, updated_at`.

`easygas_stag_code` is new this session — EasyGas's real STAG-format branch code (e.g. `"01/1"`), genuinely distinct from `code` (this app's own internal identifier, e.g. `"BR001"`). No column exists to auto-populate it; it's a manual, ops-entered value (see [07-easygas-integration.md](07-easygas-integration.md)). Doubles as the inventory system's "warehouse" concept.

### `registration_requests` — Live
`id, first_name, last_name, region, district, branch_code, branch_id → branches.id (nullable), phone, username, password_hash, photo_filename NOT NULL, status ENUM('PENDING','APPROVED','REJECTED') DEFAULT 'PENDING', notes, reviewed_at, reviewed_by → users.id, created_at, updated_at`. Never grants login on its own — only admin approval creates the real `users` row.

## Warranty Core

### `warranty_forms` — Live
One row per vehicle gas-conversion warranty — the central business record.

- **Identity**: `employee_id → users.id` (RESTRICT).
- **Installer snapshot** (frozen at submission, never re-derived on edit): `installer_region`, `installer_district`, `installer_branch` (renamed from `organization_name` — that column no longer exists under that name), `installer_full_name`, `installer_phone`, `installer_branch_code`.
- **Organization/customer**: `city`, `organization_phone` (kept under this exact name — a genuinely separate field from `installer_phone`), `owner_full_name`, `owner_phone` — plain data, **no FK to any customer/user account**; owners are not accounts in this system.
- **Vehicle**: `vehicle_name` (current free-text field) + optional `car_id → cars.id` catalog match; `vehicle_brand`/`vehicle_model`/`vehicle_engine_volume`/`vehicle_engine_power` — **Legacy**, nullable, historical-display only, never written by current code; `vehicle_production_year`, `vehicle_vin`, `vehicle_mileage` required; `vehicle_plate_number` nullable.
- **`fuel_type` ENUM('LPG','CNG') NULL** — single top-level fuel type for the whole installation.
- **Legacy 4-slot flat equipment columns** — `reducer_fuel_type/manufacturer/serial_number`, `cylinder_fuel_type/manufacturer/serial_number`, `stag_controller_manufacturer/serial_number`, `injector_rail_manufacturer/serial_number` — all nullable, all **Legacy**, superseded by `warranty_equipment`.
- **`warranty_book_number`** — nullable; installers no longer type one, EasyGas generates the real value and it's written back by the sync sweep.
- **EasyGas sync columns** (written only by the background sweep, never by create/update): `submission_uuid VARCHAR(36) UNIQUE`, `easygas_sync_status ENUM('PENDING','SYNCING','SYNCED','FAILED')`, `easygas_sync_terminal BOOLEAN`, `easygas_sync_attempts INT`, `easygas_sync_claimed_at`, `easygas_synced_at`, `easygas_warranty_number`, `easygas_last_error`.
- Indexes: `idx_warranty_forms_sync_status(easygas_sync_status)`, `idx_warranty_forms_installation_date(installation_date)`.

### `warranty_form_products` — Dead
`id, warranty_form_id → warranty_forms.id (CASCADE), product_id → products.id (RESTRICT, UNIQUE), created_at`. Superseded by `warranty_equipment`'s fixed 4-slot model; a one-time migration already promoted any pre-existing rows. **No new warranty ever writes here again.** Kept only so historical rows keep displaying.

### `warranty_equipment` — Live
One row per warranty per fixed equipment slot — the current model.

- `warranty_form_id → warranty_forms.id` (CASCADE), `equipment_type ENUM('REDUCER','CYLINDER','CONTROLLER','INJECTOR_RAIL')`, `UNIQUE(warranty_form_id, equipment_type)`.
- **`product_id` — originally `NOT NULL` with `ON DELETE RESTRICT`, relaxed to nullable this session** to support a free-text ("typed") cylinder. Still `RESTRICT` when non-null.
- `product_name` (server-derived label, never client-submitted).
- `serial_number` (nullable).
- **`brand_name`, `model` — new this session**, populated only for a typed cylinder (`product_id IS NULL`, `equipment_type='CYLINDER'`); always null for the other 3 types and for a catalog-picked cylinder.
- `inventory_item_id → inventory_items.id` (SET NULL) — the exact physical unit claimed; always null for a typed cylinder, since there's no barcode/inventory concept for one.
- **Dormant**: `equipment_validation_status ENUM('PENDING','VALID','INVALID')`, `validated_at`, `reward_points`, `reward_transaction_id`, `validation_response JSON` — schema-ready for a still-unbuilt external STAG equipment-validation API, never populated by any code path.

## Catalog (EasyGas-Synced)

### `products` — Live
Installable equipment models (not physical units — see `inventory_items`).

- `category` ENUM, 10 values (`REDUCER, CYLINDER, ECU, INJECTOR_RAIL, FILLING_VALVE, MULTIVALVE, PRESSURE_SENSOR, FILTER, OTHER, CONTROLLER`).
- `brand_id → brands.id` (nullable) alongside the original free-text `brand` column — **deliberately dual-written**, since search/display still reads the text column.
- **`external_id` — Live, not dormant.** The previous documentation pass called this dormant "until a future external STAG catalog integration" — that integration is exactly what's live now; every EasyGas-sourced product carries a real `external_id` confirmed to match EasyGas's own catalog ids.
- `fuel_type ENUM('LPG','CNG') NULL` — `NULL` means fuel-agnostic, derived from EasyGas's `station_type`.
- `serial_number`, `qr_code` — **Dead**, from when this table was one-row-per-physical-unit; unique indexes dropped.
- `score INT DEFAULT 0` — **Dead**, superseded by `product_point_configs`, never read by any current code path.
- `status ENUM('IN_STOCK','INSTALLED','RETIRED')` — **Dead**, superseded by `is_active`.
- `is_active`, `synced_at`.

### `brands` — Live
EasyGas-synced. `external_id UNIQUE`, `name`, `full_name`, `country`, `logo_url`, `synced_at`. No cross-worker deletion-detection added this session (only `products`/`cars` got it) — out of scope for now, a small stable list.

### `cars` — Live
EasyGas-synced vehicle catalog, flat `brand`/`model` strings (not FK'd to `brands`). `external_id UNIQUE`, `is_active` (**new this session**, deletion-detection support), `external_updated_at` (**Dead** — never populated; the real API field is `updated_at`, received but not currently stored), `synced_at`.

### `sync_state` — Live, visibility-only
`sync_key VARCHAR(50) PRIMARY KEY, last_synced_at`. Recorded on every sync for "when did this last succeed" visibility. **Not used to filter any request** — every cycle does a full walk, deliberately (see [07-easygas-integration.md](07-easygas-integration.md) for why incremental sync can't detect catalog deletions).

## Inventory

### `inventory_import_batches` — Live
`product_id → products.id` (RESTRICT), `uploaded_by → users.id` (RESTRICT), `file_name`, `total_rows`/`imported_count`/`skipped_count`/`duplicate_count`/`error_count`, `created_at`.

### `inventory_items` — Live
One row per real barcoded physical unit.

- `product_id → products.id` (RESTRICT), `barcode VARCHAR(150) NOT NULL UNIQUE` (globally unique, not per-product — a duplicate under a different product is a warehouse error, not a valid case).
- `status` ENUM, 7 values: `IN_STOCK, RESERVED, INSTALLED, RETURNED, DAMAGED, LOST, MERGED`.
- `branch_id → branches.id` (RESTRICT) — the "warehouse".
- `merged_into_id` — self-referential, SET NULL, for duplicate resolution.
- `import_batch_id → inventory_import_batches.id` (RESTRICT).
- Indexes: `idx_inventory_product_status(product_id, status)`, `idx_inventory_branch_status(branch_id, status)`.

### `inventory_status_history` — Live
Append-only status-transition audit log. `inventory_item_id → inventory_items.id` (CASCADE), `from_status`/`to_status`, `changed_by → users.id` (NULL = system-driven), `reason`.

### `inventory_audit_log` — Live
Audit trail for the 3 manual corrections that aren't status transitions. `inventory_item_id → inventory_items.id` (CASCADE), `action_type ENUM('BRANCH_TRANSFER','BARCODE_CORRECTED','MERGED_DUPLICATE')`, `old_value`/`new_value`, `reason NOT NULL`, `changed_by → users.id` (RESTRICT, always a real human).

## Points

### `product_point_configs` — Live
Current point value per product; absence of a row = 0 points, not a special state. `product_id → products.id` (RESTRICT — a historical CASCADE bug here, confirmed fixed, see below), `points`, `updated_by → users.id`.

### `product_point_config_history` — Live
Audit trail for point-value *changes*, distinct from the ledger. `product_id → products.id` (RESTRICT), `old_points`, `new_points`, `changed_by → users.id`.

> **Historical fix, confirmed applied**: both tables' FK to `products` was originally `ON DELETE CASCADE` — deleting a product used to silently wipe its point config and entire change-history audit trail. `ensureForeignKeyRestrict` converts this to `RESTRICT` on any database still running the old definition.

### `point_transactions` — Live
Append-only reward ledger — never UPDATEd/DELETEd. No stored balance; current balance is always a live `SUM(points)`.

`installer_id → users.id` (RESTRICT), `points`, `transaction_type ENUM('WARRANTY_AWARD','WARRANTY_REVERSAL','MANUAL_ADJUSTMENT','MANUAL_BONUS','MANUAL_PENALTY')`, `warranty_form_id`/`warranty_equipment_id` (both SET NULL), `product_id → products.id` (RESTRICT), `reversed_transaction_id` (self-referential), `reason` (frozen human-readable text), `idempotency_key UNIQUE` (repeat submissions return the original transaction). Indexes: `idx_point_transactions_installer(installer_id, created_at)`, `idx_point_transactions_warranty_equipment(warranty_equipment_id)`, `idx_point_transactions_created_at(created_at)`.

## Relationship Graph

- `users.branch_id → branches.id`
- `warranty_forms.employee_id → users.id`; `.car_id → cars.id` (optional, falls back to free-text `vehicle_name`)
- `registration_requests.branch_id → branches.id`; `.reviewed_by → users.id`
- `warranty_equipment.warranty_form_id → warranty_forms.id` (CASCADE); `.product_id → products.id` (RESTRICT, **now nullable**); `.inventory_item_id → inventory_items.id` (SET NULL)
- `products.brand_id → brands.id`
- `inventory_items.product_id → products.id`; `.branch_id → branches.id`; `.import_batch_id → inventory_import_batches.id`; `.merged_into_id →` itself
- `inventory_status_history`/`inventory_audit_log.inventory_item_id → inventory_items.id` (CASCADE)
- `product_point_configs`/`product_point_config_history.product_id → products.id` (RESTRICT)
- `point_transactions` fans out to `users`, `warranty_forms`, `warranty_equipment` (both SET NULL), `products`, and itself (reversal chain)

## One-Time Backfill / Migration Functions (run every boot, idempotent)

1. **`backfillBranches`** — promotes historical free-text `branch_code` values into real `branches` rows.
2. **`seedPlaceholderBranches`** — fresh-install-only seed, no-ops once `branches` has any row.
3. **`migrateWarrantyFormProducts`** — one-time promotion of legacy `warranty_form_products` rows into `warranty_equipment`.
4. **`backfillWarrantyFuelType`** — fills `warranty_forms.fuel_type` from historical per-row data.
5. **`backfillEasyGasSkipLegacyWarranties`** — marks pre-EasyGas-integration warranties terminal-`FAILED` so they don't starve the retry sweep.

All migrations in this file are confirmed additive-only — zero destructive drops found anywhere; every change either adds a column/table/index or relaxes a constraint (`ensureColumn`, `ensureNullableColumn`, `ensureColumnRenamed`, `ensureForeignKeyRestrict`, `ensureIndexAdded`, `ensureEnumValue`), checked against `information_schema` first so re-running on every boot is always safe.
