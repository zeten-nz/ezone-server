# 04 — Backend: Auth, Architecture, and Business Systems

[← Back to index](01-project-overview.md)

## Authentication &amp; Authorization

### Login flow

`POST /api/auth/login` looks up `SELECT * FROM users WHERE username = ? AND is_active = TRUE`, compares via `bcrypt.compare`. On success, signs a JWT `{ id, username, role, full_name, is_super_admin }`, expiry `JWT_EXPIRE` (default `7d`), updates `last_login_at`. On no match, distinguishes disabled-account vs. pending/rejected registration **without leaking existence to a guesser** — a pending/rejected request's status is only revealed after the submitted password is re-verified against that request's own hash.

Registration never creates a `users` row directly — `POST /api/auth/register` inserts into `registration_requests` (`PENDING`), requiring a photo verified via magic bytes. An admin must approve it.

### Token verification — not purely stateless

`verifyToken` does `jwt.verify()` then a **live database call on every single request**: `SELECT is_active, role, is_super_admin FROM users WHERE id = ?`. Missing row or `is_active=false` → 401. The fresh DB values overwrite the token's own `role`/`is_super_admin` — only `id`/`username`/`full_name` are trusted from the token. **A deactivated account or a role/permission change takes effect on the very next request, not at the 7-day expiry.**

### Roles &amp; Super Admin

`users.role ENUM('ADMIN','EMPLOYEE')` — exactly two roles. **Super Admin is not a third role** — `is_super_admin BOOLEAN` layered on `ADMIN`, checked by `requireSuperAdmin` (must be both). Always stacked (`verifyToken → authorizeRole('ADMIN') → requireSuperAdmin`), never a replacement.

### Rate limiting — exact configuration (`server.js`)

```js
// Global — all /api routes except /api/reports
rateLimit({ windowMs: 15*60*1000, max: 100, skip: (req) => req.originalUrl.startsWith('/api/reports') })
// Reports — its own, larger budget (a dashboard render legitimately fires ~10 concurrent GETs)
rateLimit({ windowMs: 15*60*1000, max: 500 })
// Auth — login + register share this one budget
rateLimit({ windowMs: 15*60*1000, max: 10 })
```
`app.set('trust proxy', 1)` — required for `req.ip` to reflect the real client through Nginx.

### Public endpoints (everything else requires a token)

| Endpoint | Why public |
|---|---|
| `GET /health` | Infra liveness probe |
| `POST /api/auth/register` | Pre-account applicant form |
| `POST /api/auth/login` | This is how a token is obtained |
| `GET /api/branches/public` | Branch picker on the pre-login registration form |

A fifth public endpoint, a phone-number-only customer warranty lookup, existed at one point this session and was **removed entirely** after being confirmed as an unauthenticated PII leak — see [09-security.md](09-security.md). There is currently no customer-facing endpoint of any kind.

### Token lifecycle

Expiry only (`JWT_EXPIRE`, default 7 days). **No refresh, rotation, or server-side revocation list.** Deactivating the account is the only immediate remedy short of rotating `JWT_SECRET` (which invalidates every token for every user at once).

---

## Backend Architecture

### The intended layering, evidenced by the warranty domain

- **Controller** — parses/validates HTTP input, acquires a pool connection, calls the service, translates results/`AppError` into a response, always releases the connection in `finally`.
- **Service** — owns business rules and the transaction boundary.
- **Repository** — pure parameterized SQL, no business logic.

**Not applied consistently.** `controllers/userController.js` talks directly to the connection pool with inline SQL and zero service/repository indirection. Warranty, inventory, and points follow the intended 3-layer split; users (and branches/products, to a lesser degree) do not. See [12-architecture-review.md](12-architecture-review.md).

### `utils/` and `dtos/`

`utils/` holds cross-cutting helpers: `AppError.js`, `csvBarcodeParser.js`, `csvStream.js`, `vehicleName.js`, `warrantyEquipment.js`, plus two added this session — `phoneFormat.js` (best-effort `+998` canonicalization before an EasyGas push) and `easyGasSigning.js` (HMAC signing, shared by both the warranty and catalog EasyGas clients — previously duplicated/private to one client). `dtos/` contains exactly one file, `warrantyDTO.js`, used only by `warrantyController.js`.

---

## Warranty System

### Creation

`POST /api/warranty` (any authenticated role) pulls an **employee snapshot** (installer's name/phone plus their branch's full location) — missing/incomplete branch data throws `INCOMPLETE_PROFILE` before any write. Equipment must be exactly the 4 required slots; each is resolved and validated, with one exception added this session: **a `CYLINDER` row with no `product_id` is a typed (free-text) cylinder** — no catalog lookup, no barcode, no inventory claim, requiring only a non-empty `model`. The other 3 types are unaffected. `product_name` is always server-derived, never client-submitted.

**Idempotent create, added this session**: before any expensive work, `createWarrantyForm` checks whether `submission_uuid` already has a warranty (`warrantyRepository.findBySubmissionUuid`) — a retried POST (e.g. after a client timeout) returns the existing form (`200`) instead of hitting a raw UNIQUE-constraint error. A second check after a lost INSERT race (two near-simultaneous retries) covers the narrow window between the pre-check and the insert.

The whole thing is one transaction: insert `warranty_forms`, atomically claim each real (non-typed) equipment row's barcode from inventory (a lost race throws `BARCODE_CLAIM_FAILED` and rolls back everything, including earlier claims in the same loop), write the 4 `warranty_equipment` rows, award points per row (0 for a typed cylinder — there's no product to look up a point value for). After commit, the warranty sits `PENDING` — the EasyGas push is never awaited synchronously.

### Editing

Non-admins may edit **only their own form**, **only within 24 hours**; admins are unrestricted. A row lock (`SELECT ... FOR UPDATE`) serializes concurrent edits/deletes. Installer/branch snapshot fields, `submission_uuid`, `warranty_book_number`, and every `easygas_sync_*` column are **never touched by an edit**. Change-detection now also compares `brand_name`/`model` (not just `product_id`/`serial_number`), so a typed cylinder's text being edited is correctly caught; switching a row between a catalog product and typed text in either direction correctly releases/reclaims inventory and reverses/reawards points.

### Status concepts

`easygas_sync_status` (PENDING/SYNCING/SYNCED/FAILED) is the sync lifecycle; `easygas_sync_terminal` distinguishes a retryable FAILED from one needing admin action. **There is still no separate "warranty validity" status** (active/expired/cancelled) anywhere in this schema — EasyGas's response does carry `term_months`/`expires_at`/`status`, but nothing here stores or reads them yet.

### Retry &amp; failure handling

Only the background sweep ever pushes to EasyGas. See [07-easygas-integration.md](07-easygas-integration.md) for the full retry/classification detail (expanded significantly this session).

---

## Inventory System

**`products` vs `inventory_items`** is a deliberate catalog-vs-physical-unit split.

### CSV import

Real CSV parsing (`csv-parse`), not a line-splitter — tries comma/semicolon/tab and keeps whichever produces the widest header row (the library's own delimiter auto-detection can't handle quoted fields). Barcode column located by header keyword (English + Russian), falling back to column 0. Duplicate/error classification happens in JavaScript before any INSERT — only a genuine mid-import failure rolls back.

### Barcode claim/release

```sql
UPDATE inventory_items SET status = 'X' WHERE id = ? AND status = 'Y' LIMIT 1
```
checked via `affectedRows === 1` — the one concurrency-safety idiom reused everywhere in this domain (claim/release, manual status change, branch transfer, merge).

### Manual admin operations (all Super-Admin-gated)

`changeStatusManually`, `transferBranch`, `correctBarcode` (blocked on `INSTALLED` items — the EasyGas payload is built from a frozen serial copy), `mergeDuplicate` (only from `IN_STOCK`, atomic).

### Stock lifecycle

`IN_STOCK` ⇄ `INSTALLED` are the only automatic transitions. `RESERVED`/`RETURNED`/`DAMAGED`/`LOST` are manual-only. `MERGED` is terminal.

---

## Points System

Append-only ledger — never UPDATEd/DELETEd; balance is always a live `SUM(points)`.

Awarded automatically, once per equipment row, at submission/change time, from the product's *currently* configured value — 0 points writes nothing at all. A typed cylinder always resolves to 0 (no product to configure a value against) with zero special-casing needed, since the points repository's lookup on a `NULL` product id simply matches no rows. Reversal fires symmetrically on edit (changed rows) and delete, always crediting the warranty's original installer.

Manual adjustments (Super-Admin-only): adjustment/bonus/penalty, sign-constrained, mandatory reason, optional idempotency key.

---

## Reporting

All under `/api/reports`, ADMIN-gated except `/my-statistics`. Every count/sum is real SQL aggregation. See the auto-generated backend audit for the exact computation behind every endpoint if you need it — unchanged this session, not re-detailed here.

---

## Background Jobs

Exactly two recurring jobs. Both start in `server.js`'s `startServer()`, after `initializeDatabase()` and before `app.listen()`.

| Job | Interval (env var, default) | Overlap protection | Error isolation |
|---|---|---|---|
| Warranty retry sweep | `EASYGAS_SYNC_INTERVAL_MS`, 30s | Atomic per-row claim (cluster-safe) | Per-row try/catch + outer `.catch()` |
| Catalog sync sweep | `EASYGAS_CATALOG_SYNC_INTERVAL_MS`, 5min | **Gated to PM2 worker 0 only — added this session** (was previously "none, every worker pulls independently") | Same outer `.catch()` pattern |

See [07-easygas-integration.md](07-easygas-integration.md) for full detail on what each sweep does — that file changed substantially this session and is the authoritative source for this integration, not this summary.
