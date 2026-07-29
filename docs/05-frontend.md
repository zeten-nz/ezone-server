# 05 — Frontend Architecture

[← Back to index](01-project-overview.md)

`src/App.jsx` is the root: `ErrorBoundary(Global) → LanguageProvider → AuthProvider → SidebarProvider → Router → Suspense → Routes`. Every page is `lazy()`-loaded with its own inline `ErrorBoundary`. Root `/` renders `RootRedirect`, sending the user to `getHomePath(role)` or `/login`.

## Layouts

`ModernAdminLayout.jsx`/`ModernEmployeeLayout.jsx` — both compose the same shared `Sidebar`/`Navbar`; role differentiation happens inside `Sidebar` (which items it renders), not via separate layout components.

## Pages — typical structure

Local `useState` for data/loading/error plus a `refreshKey` counter; one `useEffect` async fetch with try/catch/finally; skeleton / `ErrorState` / real content, always inside the layout. Every page calls services exclusively through `services/api.js`'s aggregated exports.

## Auth flow

- **Storage**: `localStorage`, keys from `STORAGE_KEYS` (`ezone_token`, `ezone_user`, `ezone_language`), read/written atomically via `authStorage.js`. `getStoredAuth()` client-side decodes the JWT payload (no signature check) and proactively treats an expired token as absent.
- **Attaching to requests**: axios request interceptor sets `Authorization: Bearer <token>` and `X-Language` (read from `localStorage`, since the client module sits outside React) on every call.
- **401 handling**: axios response interceptor — a 401 outside the login/register/change-password allowlist (those 401s just mean "wrong password") clears storage and emits an `unauthorized` event via a plain pub/sub (`authEvents.js`, since the client can't call `useAuth()` directly); `AuthContext` logs out with reason `'expired'`.
- **Error normalization**: every rejected promise becomes an `AppError` via `config/errorCodes.js` — a hand-maintained bilingual (uz/ru) dictionary keyed by backend `errorCode`.

### Role-based UI gating

Only `ADMIN`/`EMPLOYEE` exist in `USER_ROLES` — **there is no `SUPER_ADMIN` entry and no route-level super-admin protection.** `user.is_super_admin` is instead checked ad hoc, inline, in exactly three pages (`AdminInventoryModern.jsx` for the 4 manual inventory ops, `AdminPointsConfigModern.jsx` for editing point values, `AdminInstallerPointsModern.jsx` for manual adjustments + CSV export). **There is no UI anywhere to toggle a user's `is_super_admin` flag** — it must be set directly in the database.

## The warranty submission form (`WarrantyFormFields.jsx`)

Shared by create, the employee's own edit modal, and the admin edit modal — one component, three call sites.

### The most important frontend/backend gap this documentation pass found

**Equipment is still 100% catalog-only for all 4 types, including the cylinder.** `config/equipmentCategories.js`'s `EQUIPMENT_TYPES` renders 4 fixed rows; each is a strict cascade — Brand `<Select>` → Product `<Autocomplete>` (disabled until a Brand is picked) → serial/barcode `<Input>` (disabled until a Product is picked). `validateWarrantyForm` requires `row.product` to be truthy for every row, cylinder included, with no text-input alternative anywhere.

**This means the backend's typed-cylinder capability (see [07-easygas-integration.md](07-easygas-integration.md)) cannot currently be used by anyone.** The backend accepts a product-less cylinder; nothing in this frontend can produce one. This is the single largest implemented-but-unreachable gap in the system right now. Closing it is the first item in [11-roadmap.md](11-roadmap.md).

### What does work, confirmed

- **Fuel type**: one top-level selector (`LPG`/`CNG`), shared across the whole installation, also scoping the Product autocomplete.
- **Vehicle**: `vehicle_name` with a genuine catalog-first/free-text-fallback pattern — an `Autocomplete` backed by `carAPI.search`, picking a suggestion sets `car_id` and normalizes the text; editing afterward clears `car_id` back to null. This is the exact pattern the cylinder still lacks.
- **`submission_uuid`**: generated client-side via `crypto.randomUUID()` inside a dedicated `createEmptyWarrantyForm()` factory (never by spreading a shared template, to avoid every fresh form sharing one module-load-time UUID); reused unchanged across every edit.
- **`warranty_book_number`**: shown read-only, "pending sync" until EasyGas assigns it — never an input.
- **VIN scanning**: a camera icon opens a VIN-only OCR pipeline (OpenCV.js/jscanify + Tesseract.js), dynamically imported so the ~8 MB payload only loads on demand.

## Admin screens

- **`AdminWarrantyFormsModern.jsx`** — list/search/paginate, with a **Sync Status** column/badge (`PENDING/SYNCING/SYNCED/FAILED`) and a translated failure reason parsed from `easygas_last_error`'s leading `CODE:` token via `config/errorCodes.js`. A **Retry Sync** button appears only for `FAILED` rows.
  - **Confirmed stale as of this session**: `errorCodes.js` recognizes only `PRODUCT_UNKNOWN`, `FIELD_TOO_LONG`, `INVALID_VALUE`, `INVALID_DATE`, `WARRANTY_LOCKED`, `PRODUCT_NOT_MAPPED`. The 6 terminal codes added to the backend this session — `FIELD_REQUIRED`, `BRANCH_UNKNOWN`, `CAR_UNKNOWN`, `FUEL_TYPE_MISMATCH`, `COMPONENTS_INCOMPLETE`, `PHONE_INVALID` — are **not yet in this dictionary**. They'll still show a leading code token (so nothing breaks), but fall through to a generic translated message instead of a specific one. Second item in [11-roadmap.md](11-roadmap.md).
- **Branch management** (`AdminBranchesModern.jsx`/`BranchFormModal.jsx`) — fields are `code` (immutable), `name`, `phone`, `region`, `district`, `city`. **No `easygas_stag_code` field exists anywhere in the frontend** — the backend's admin endpoint for looking it up (`GET /api/branches/easygas`) and the field itself (`PUT /api/branches/:branchId`) both exist server-side with no UI to reach them yet. Third item in [11-roadmap.md](11-roadmap.md).
- **Inventory** (`AdminInventoryModern.jsx`) — status filter across all 7 values, CSV import modal, manual ops gated to super admin.
- **Points/rewards** — per-product config table, per-installer ledger + manual adjustment form, employee's own read-only ledger.
- **Products/Users/Registration requests** — standard CRUD/approval screens, nothing EasyGas-specific.
- **Reports/dashboard** — stat tiles, trend charts, leaderboards, per-entity drill-downs, CSV/Excel export triggers throughout (two independent export systems — see [04-backend.md](04-backend.md)).

## Contexts, hooks, services

Unchanged this session — `AuthContext`/`LanguageContext`/`SidebarContext`; 6 debounced-search hooks; one shared axios instance (`src/api/client.js`) behind 13 per-domain service files aggregated by `src/services/api.js`.

## Build

Vite, manual vendor chunking for react/router/axios only (everything else — OCR pipeline, recharts, framer-motion — left to automatic per-route chunking since each is reachable from exactly one lazy route). `.env.production`/`.env.example` point at `https://api.easygas-garant.uz/api`. No test suite exists (confirmed — no Jest/Vitest/Playwright/Cypress anywhere, no `test` script).

Two stray, non-source artifacts currently sit in the repo working tree: an untracked `dist.zip` (a zipped build output, not committed) and a leftover `lint_output.txt` from a past lint run. Neither affects the app; worth cleaning up.
