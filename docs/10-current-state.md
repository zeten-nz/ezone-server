# 10 — Current Project State

[← Back to index](01-project-overview.md)

This is a factual ledger — what's done, what's dormant, what's broken, what's known-limited. For a critical, opinionated engineering assessment, see [12-architecture-review.md](12-architecture-review.md). For what's planned but not built, see [11-roadmap.md](11-roadmap.md). Nothing in this file is speculative — everything here traces to code, a live test, or an explicit code comment.

## Completed &amp; Live

Warranty submission/edit/delete with atomic inventory claiming (including a typed, catalog-optional cylinder), the full inventory CSV-import + manual-correction toolchain, the automatic points-award/reversal ledger with manual Super-Admin adjustments, and the full reporting/statistics surface are all real, working, and exercised end to end. Warranty creation is fully local and synchronous — a warranty number is assigned sequentially (`W-YYYY-NNNNNN`) inside the same transaction that creates the row, with no external dependency of any kind.

**The previously-integrated third-party warranty-sync/catalog-sync platform has been fully and permanently removed.** What that means concretely:
- No more sync status — a warranty is simply created once its row exists in `warranty_forms`; there's no PENDING/SYNCING/SYNCED/FAILED lifecycle, no retry, no sync sweep, no background jobs. Reports/statistics/dashboards read local warranty data only.
- Brands and cars are now local ERP master data with full admin CRUD (`brandRepository.js`/`brandController.js`/`brandRoutes.js` at `/api/brands`; `carRepository.js`/`carController.js`/`carRoutes.js` at `/api/cars`, plus the pre-existing `/api/cars/search`), not externally-synced catalogs. `products.brand_id` is a real FK to `brands.id`.
- Warranty numbers are generated locally and sequentially (`getNextWarrantyNumber`, `warrantyRepository.js`) — e.g. `W-2026-000001` — via a `warranty_number_sequences` table, atomically inside `createWarrantyForm`'s transaction.
- Idempotent warranty creation is retained — a retried `POST` with the same `submission_uuid` returns the existing form instead of a raw duplicate-key error.
- A set of deprecated legacy columns from the old integration (sync-tracking fields on `warranty_forms`, a STAG-branch-code field on `branches`, and `external_id`/`synced_at`/`external_updated_at` on `products`/`brands`/`cars`) still physically exist in the database — Phase 1 of a two-phase removal — but are no longer read or written by any code path. A future Phase 2 migration will drop them once everything is verified. See [03-database.md](03-database.md).

## Unfinished / Dormant

Stated explicitly in the code's own comments, not inferred:

- An entire external STAG **equipment-validation** API integration (a separate, still-unbuilt integration, distinct from the removed catalog/warranty-sync integration) — `warranty_equipment`'s `equipment_validation_status`, `validated_at`, `reward_points`, `reward_transaction_id`, `validation_response` columns are schema-ready but never populated by any code path.
- `warranty_form_products`, `warranty_forms`' original per-equipment flat columns, `vehicle_brand`/`vehicle_model`, `products.score`, `products.status` — all fully superseded, kept only so historical rows keep rendering or because migrations never drop columns.
- No "warranty validity" (active/expired/cancelled) concept exists anywhere in this schema — it never has, independent of the (now-removed) third-party integration.

## Confirmed Broken

- The documented `create-admin.js` first-admin bootstrap script does not exist in the repository, despite being referenced by both `package.json` and `docs/deployment-guide.md`. **Unchanged this session** — confirmed still missing.

## Implemented But Currently Unreachable

- **The typed-cylinder backend capability has no frontend to use it.** The form still hard-requires a catalog product for all 4 equipment types. See [05-frontend.md](05-frontend.md).

## Known Limitations, Stated Directly

- No JWT refresh/revocation mechanism exists.
- There is no "warranty validity" concept anywhere — a warranty is simply created; nothing tracks active/expired/cancelled state.
- Four of the seven `inventory_items` statuses (`RESERVED`, `RETURNED`, `DAMAGED`, `LOST`) have no automatic trigger — manual admin actions only.
- No automated test suite exists anywhere in either repository — confirmed directly (no test files, no test runner dependency, no `test` script) in both a fresh backend and frontend audit this session.

## Code Quality Review

See [12-architecture-review.md](12-architecture-review.md) for the full, critical version. Short version: maintainability is high in the domains that received the most iteration (warranty, inventory, points) — real transaction discipline, one proven atomic-guard idiom reused everywhere, additive-only migrations with zero exceptions found, and an unusually high proportion of self-documenting comments explaining *why*, not just what. It's lower in domains touched less recently (`userController.js` bypasses the service/repository layers entirely) — a recognizable shape for a system that grew in phases, evidenced directly rather than assumed.

**Recommendation for anyone extending this codebase**: read `services/warrantyService.js` first — it shows both the intended architectural pattern (transaction boundary, atomic inventory claim, points award, local sequential warranty numbering) and the general code quality bar the rest of the codebase should be held to. Treat `userController.js` as an outlier, not an alternative style.
