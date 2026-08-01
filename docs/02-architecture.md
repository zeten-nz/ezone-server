# 02 — Technology Stack &amp; Folder Structure

[← Back to index](01-project-overview.md)

## Technology Stack

### Frontend — `ezone` (package name `"client"`)

| Concern | Choice |
|---|---|
| Framework | React 19.2 |
| Routing | react-router-dom 6.20 |
| State management | Plain React Context — no Redux/Zustand/etc. (`AuthContext`, `LanguageContext`, `SidebarContext`), backed by `localStorage` |
| Forms | react-hook-form 7.81 + `@hookform/resolvers` + zod 4 schemas |
| UI components | Hand-built — no component library. lucide-react/react-icons for icons, framer-motion for animation, recharts for charts |
| Specialty libs | react-webcam, jscanify, `@techstark/opencv-js`, tesseract.js — client-side document scanning/OCR (vehicle document capture) |
| Styling | Tailwind CSS 3.4 + `@fontsource/inter` |
| Build tool | Vite 8 (manual vendor chunking for react/router/axios, hidden sourcemaps) |
| Package manager | npm (`package-lock.json` present) |

### Backend — `ezone-server` (package name `"ezone-api"`)

| Concern | Choice |
|---|---|
| Runtime | Node ≥18 required (README states Node 20 LTS used in practice) |
| Framework | Express 4.18 |
| Authentication | jsonwebtoken + bcryptjs |
| Middleware | helmet (security headers), cors (origin allowlist), compression (gzip), morgan (request logging), express-rate-limit (3 distinct limiters) |
| Validation | express-validator |
| Uploads | multer — disk storage + magic-byte verification for photos, memory storage for CSV |
| Excel/CSV | exceljs (legacy XLSX export), csv-parse (CSV inventory-import parsing) |
| Scheduled jobs | None — no job-scheduler package, no background polling loops; all work happens synchronously within the request/transaction that triggers it |
| Package manager | npm |

### Database

**MySQL 8** via the `mysql2/promise` driver, as a connection pool. **No migration framework** — no Knex/Sequelize/Umzug/Prisma. Migrations are entirely hand-rolled: one large `initializeDatabase()` function in `config/database.js` runs `CREATE TABLE IF NOT EXISTS` for every table plus a long sequence of idempotent helper functions (`ensureColumn`, `ensureNullableColumn`, `ensureColumnRenamed`, `ensureForeignKeyRestrict`, `ensureIndexAdded`/`Dropped`, `ensureEnumValue`, plus one-off data backfills) that check `information_schema` and only alter if needed — safe to re-run on every boot. A genuine **repository pattern** exists (`repositories/`, one file per aggregate), though not applied with perfect consistency (see [04-backend.md](04-backend.md) and [10-current-state.md](10-current-state.md)).

### Infrastructure

**Nginx** (TLS termination, static file serving for the React build, reverse proxy to the Node process, SPA fallback routing) + **PM2** (cluster mode, one worker per CPU core) + **Let's Encrypt/Certbot** for SSL. Configuration is entirely `.env`-based via `dotenv`, validated at boot. Full detail in [08-deployment.md](08-deployment.md).

---

## Folder Structure

### `ezone-server/`

| Folder | Purpose |
|---|---|
| `config/` | Static config + the entire DB schema/migrations (`database.js`), plus `csvLabels.js` (bilingual CSV export labels), `equipmentCategories.js`, `externalCategoryMap.js`, `mockData.js` (dev-only seed data), `uploads.js` (multer setup), `validation.js` |
| `controllers/` | Thin HTTP handlers — one per domain (auth, users, warranty, inventory, products, brands, cars, branches, reports, registration requests, legacy Excel export, CSV export). **The public customer-lookup controller was removed this session** — see [09-security.md](09-security.md). |
| `services/` | Business logic and transaction boundaries — `warrantyService.js`, `inventoryService.js`, `pointsService.js`, `productService.js`, `validationService.js` |
| `repositories/` | Parameterized SQL access, one file per aggregate root (warranty, equipment, product, brand, car, inventory, inventory-audit-log, inventory-import-batch, point-transaction, product-point-config) |
| `routes/` | Express routers wiring URLs → middleware → controllers, one per domain. **`routes/publicCustomerRoutes.js` was removed this session.** |
| `middleware/` | `auth.js` (JWT verify + role checks), `errorHandler.js` (centralized error/404 responses), `validateEnv.js` (startup config validation) |
| `dtos/` | Exactly one file, `warrantyDTO.js` — response shaping for the warranty domain only |
| `utils/` | `AppError.js`, `csvBarcodeParser.js`, `csvStream.js`, `vehicleName.js`, `warrantyEquipment.js`, `phoneFormat.js` (best-effort `+998` phone-number canonicalization) |
| `uploads/` | Runtime-written photo storage — `profile-photos/`, `registration-photos/`. Gitignored; must be preserved across deploys |
| `docs/` | This documentation (11 numbered files), plus deployment/update/backup guides |

### `ezone/src/`

| Folder | Purpose |
|---|---|
| `pages/` | One file per route/screen, ~20 lazy-loaded pages, flat (no subfolders) — Login/Register, 5 Employee-facing, 13 Admin-facing |
| `components/` | `UI/` is the reusable kit (Button, Card, Input, Modal, DataTable, Pagination, Toast, etc., barrel-exported). Domain folders (`Dashboard/`, `Warranty/`, `Inventory/`, `Products/`, `Branches/`, `Users/`, `RegistrationRequests/`, `Profile/`, `Header/`) hold page-specific pieces. `VehicleScanner/` is a large, self-contained OCR/camera pipeline with its own sub-structure |
| `context/` | Exactly 3 files — `AuthContext.jsx`, `LanguageContext.jsx`, `SidebarContext.jsx` |
| `hooks/` | 6 custom hooks, mostly debounced-search hooks for different catalog lookups |
| `services/` | One file per API domain (13 files) wrapping the shared axios client — pages never call it directly, only through `services/api.js`'s aggregator |
| `api/client.js` | The single shared axios instance — base URL, auth header injection, 401 handling, error normalization |
| `config/` | Frontend constants — navigation config, error-code dictionary, category lists, date ranges, status-badge mapping |
| `validation/` | Zod schemas for forms |
| `utils/` | `authStorage.js`, `authEvents.js`, assorted formatting helpers |

See [05-frontend.md](05-frontend.md) for how these pieces fit together.
