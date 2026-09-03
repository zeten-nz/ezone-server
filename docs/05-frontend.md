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

**Equipment entry is catalog-only, but the cylinder slot is now OPTIONAL (Beta-3).** `config/equipmentCategories.js`'s `EQUIPMENT_TYPES` renders the 4 canonical rows; the `CYLINDER` row starts disabled ("Tsilindr qo'shish" opt-in) and, when disabled, is omitted from the wire payload entirely (`toWireEquipment`). Each enabled row is a strict cascade — Brand `<Select>` → Product `<Autocomplete>` (disabled until a Brand is picked) → serial `<Input>` (disabled until a Product is picked). `validateWarrantyForm` (extracted to `src/utils/warrantyFormValidation.js`) requires `row.product` for every ENABLED row, except an enabled cylinder carrying existing typed identity (`brand_name`/`model` round-tripped from history).

**NEW typed cylinders still cannot be created from this frontend** (no free-text entry UI), but existing typed-cylinder warranties now round-trip through edit correctly instead of failing `CYLINDER_MODEL_REQUIRED`. Building a typed-cylinder creation UX remains a roadmap item in [11-roadmap.md](11-roadmap.md).

### What does work, confirmed

- **Fuel type**: one top-level selector (`LPG`/`CNG`), shared across the whole installation, also scoping the Product autocomplete.
- **Vehicle**: `vehicle_name` with a genuine catalog-first/free-text-fallback pattern — an `Autocomplete` backed by `carAPI.search`, picking a suggestion sets `car_id` and normalizes the text; editing afterward clears `car_id` back to null. This is the exact pattern the cylinder still lacks.
- **`submission_uuid`**: generated client-side via `crypto.randomUUID()` inside a dedicated `createEmptyWarrantyForm()` factory (never by spreading a shared template, to avoid every fresh form sharing one module-load-time UUID); reused unchanged across every edit.
- **`warranty_book_number`**: shown read-only, populated immediately once the warranty is created (locally sequential, e.g. `W-2026-000001`) — never an input.
- **VIN scanning**: a camera icon opens a VIN-only OCR pipeline (OpenCV.js/jscanify + Tesseract.js), dynamically imported so the ~8 MB payload only loads on demand.

## Admin screens

- **`AdminWarrantyFormsModern.jsx`** — list/search/paginate. There is no sync-status column or retry button — a warranty is simply "created" once it exists; there's no lifecycle to display.
- **Branch management** (`AdminBranchesModern.jsx`/`BranchFormModal.jsx`) — fields are `code` (immutable), `name`, `phone`, `region`, `district`, `city`.
- **Brands/Cars management** (`AdminBrandsModern.jsx`+`BrandFormModal.jsx`+`brands.service.js`; `AdminCarsModern.jsx`+`CarFormModal.jsx`+extended `cars.service.js`) — full local admin CRUD, both reachable from the admin sidebar nav (`config/navigation.js`).
- **Inventory** (`AdminInventoryModern.jsx`) — status filter across all 7 values, CSV import modal, manual ops gated to super admin.
- **Points/rewards** — per-product config table, per-installer ledger + manual adjustment form, employee's own read-only ledger.
- **Products/Users/Registration requests** — standard CRUD/approval screens.
- **Reports/dashboard** — stat tiles, trend charts, leaderboards, per-entity drill-downs, CSV/Excel export triggers throughout (two independent export systems — see [04-backend.md](04-backend.md)).

## Contexts, hooks, services

Unchanged this session — `AuthContext`/`LanguageContext`/`SidebarContext`; 6 debounced-search hooks; one shared axios instance (`src/api/client.js`) behind 13 per-domain service files aggregated by `src/services/api.js`.

## Build

Vite, manual vendor chunking for react/router/axios only (everything else — OCR pipeline, recharts, framer-motion — left to automatic per-route chunking since each is reachable from exactly one lazy route). `.env.production`/`.env.example` point `VITE_API_URL` at the production API's base URL. No test suite exists (confirmed — no Jest/Vitest/Playwright/Cypress anywhere, no `test` script).

Two stray, non-source artifacts currently sit in the repo working tree: an untracked `dist.zip` (a zipped build output, not committed) and a leftover `lint_output.txt` from a past lint run. Neither affects the app; worth cleaning up.
