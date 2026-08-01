# 06 — API Reference

[← Back to index](01-project-overview.md)

Grouped by module. **Admin** = `verifyToken + authorizeRole('ADMIN')`. **Super Admin** additionally requires `requireSuperAdmin`. **Any** = any authenticated role. **Public** = no token at all. All `/api/*` paths sit behind the global rate limiter (100 req/15min/IP, `/api/reports` exempted with its own 500 req/15min limiter); `/api/auth/*` additionally gets a 10 req/15min limiter.

## Inline routes (defined directly in `server.js`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | Public | Liveness/readiness check |
| GET | `/api/export/warranty` | Admin | Streams an Excel workbook of all warranty forms |
| GET | `/api/export/branch` | Admin | Streams an Excel workbook filtered to one branch |
| GET | `/api/export/employee` | Any | Streams one employee's own warranty forms as Excel |
| GET | `/api/dashboard` | Admin | Legacy admin dashboard summary — separate from `/api/reports/dashboard-totals` |

## Auth — `/api/auth`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/register` | Public | Self-registration → PENDING request |
| POST | `/login` | Public | Credential login, issues JWT |
| POST | `/change-password` | Any | Self password change |
| GET | `/profile` | Any | Own profile |
| GET/POST/DELETE | `/profile/photo` | Any | Stream/upload/remove own profile photo |

## Users — `/api/users` (all Admin)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET/POST | `/` | Admin | List / create |
| GET/PUT | `/:userId` | Admin | Fetch / update |
| PATCH | `/:userId/disable` \| `/enable` | Admin | Activate toggle |
| PATCH | `/:userId/super-admin` | Super Admin | Grant/revoke Super Admin flag |
| POST | `/:userId/reset-password` | Admin | Force password reset |

## Warranty — `/api/warranty`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/` | Any | Submit new warranty — idempotent on `submission_uuid` (returns `200` + existing form on a genuine retry, `201` on a real create) |
| GET | `/search` | Admin | Search all warranty forms |
| GET | `/my` | Any | Own submitted forms |
| GET | `/` | Admin | List/paginate all forms |
| PUT | `/:formId` | Any (owner + within 24h) / Admin unrestricted | Edit a form |
| GET | `/:formId` | Admin | Full form detail |
| DELETE | `/:formId` | Admin | Delete a form |

Equipment array: `equipment.*.product_id` is optional; required only for `REDUCER`/`CONTROLLER`/`INJECTOR_RAIL` and for a catalog-picked `CYLINDER`. Optional fields `equipment.*.model`/`equipment.*.brand_name` support a typed (free-text) cylinder.

## Registration Requests — `/api/registration-requests` (all Admin)

Unchanged this session: list, detail, photo stream, approve, reject.

## Branches — `/api/branches`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/public` | Public | Registration form's branch picker |
| GET | `/` | Admin | List all branches |
| POST | `/` | Admin | Create a branch |
| PUT | `/:branchId` | Admin | Update a branch |
| PATCH | `/:branchId/disable` \| `/enable` | Admin | Activate toggle |

## Products — `/api/products`

Unchanged this session. `PRODUCT_CATEGORIES = ['REDUCER','CYLINDER','ECU','INJECTOR_RAIL','FILLING_VALVE','MULTIVALVE','PRESSURE_SENSOR','FILTER','OTHER','CONTROLLER']`. `GET /search`, `GET /brands` (any role), full admin CRUD.

## Reports — `/api/reports` (own 500/15min rate limiter)

Unchanged this session — see [04-backend.md](04-backend.md) for the full list, all still accurate.

## Brands — `/api/brands`

Local ERP master data — full admin CRUD via `brandRepository.js`/`brandController.js`/`brandRoutes.js`: list, active-only list, create, update, activate/deactivate, delete — all Admin.

## Cars — `/api/cars`

Local ERP master data — full admin CRUD via `carRepository.js`/`carController.js`/`carRoutes.js`: list, active-only list, create, update, activate/deactivate, delete — all Admin. Plus `GET /search` (any role) — used by the warranty form's Vehicle Name autocomplete.

## Inventory — `/api/inventory`

Unchanged this session. `INVENTORY_STATUSES` now includes `MERGED` as a 7th value (already reflected here).

## Points — `/api/points`

Unchanged this session.

## Export / CSV — `/api/export-csv`

Unchanged this session — 7 endpoints, 2 Super-Admin-only.

## Public Customer Lookup — **removed this session**

`POST /api/public/customer/warranties` (`{ phone }` → that phone number's warranties) existed at one point and has been **deleted entirely** — controller, routes, the repository method backing it, and the `server.js` mount are all gone. It was confirmed to be an unauthenticated PII leak in production use, and no confirmed consumer needed it. See [09-security.md](09-security.md).

## Summary of every public (unauthenticated) endpoint — updated

| Method | Path | Why public |
|---|---|---|
| GET | `/health` | Infra liveness probe |
| POST | `/api/auth/register` | Pre-account self-registration |
| POST | `/api/auth/login` | Entry point that produces the JWT itself |
| GET | `/api/branches/public` | Branch picker on the pre-login registration form |

Every other endpoint requires `verifyToken` at minimum. **There are now only 4 public endpoints, down from 5** — the removed one was the only endpoint in this system that ever returned customer PII without a token.
