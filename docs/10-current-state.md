# 10 — Current Project State

[← Back to index](01-project-overview.md)

This is a factual ledger — what's done, what's dormant, what's broken, what's known-limited. For a critical, opinionated engineering assessment, see [12-architecture-review.md](12-architecture-review.md). For what's planned but not built, see [11-roadmap.md](11-roadmap.md). Nothing in this file is speculative — everything here traces to code, a live test, or an explicit code comment.

## Completed &amp; Live

Warranty submission/edit/delete with atomic inventory claiming (including a typed, catalog-optional cylinder as of this session), the full inventory CSV-import + manual-correction toolchain, the automatic points-award/reversal ledger with manual Super-Admin adjustments, the full reporting/statistics surface, and EasyGas warranty-push + catalog-pull sync with crash recovery are all real, working, and exercised end to end — with the specific exception of a real successful (`2xx`) warranty push, which has never yet been observed (every live test to date used synthetic data deliberately expected to be rejected).

Newly shipped this session, all confirmed working via direct testing, not just written:
- The EasyGas catalog client now signs every request (previously unsigned/public) and shares the warranty push's base URL and secret.
- A real pagination bug that silently capped every catalog sync at page 1 is fixed and confirmed (full 179-product/409-car pulls now succeed).
- Catalog deletion detection (deactivate on a full sync's absence) and reactivation-on-reappear, for both products and cars.
- The catalog sweep is now gated to a single PM2 worker, closing a real amplification concern against EasyGas's API.
- A typed (free-text) cylinder — brand/model instead of a catalog pick — end to end: schema, service-layer resolution, inventory/points side-effects correctly skipped, and outbound payload shape.
- Idempotent warranty creation — a retried `POST` with the same `submission_uuid` returns the existing form instead of a raw duplicate-key error.
- An admin-only live lookup of EasyGas's real branch codes (`GET /api/branches/easygas`), and a `branches.easygas_stag_code` field to store the result.
- Explicit 401/403 → retryable classification in the warranty-push retry logic.

## Unfinished / Dormant

Stated explicitly in the code's own comments, not inferred:

- An entire external STAG **equipment-validation** API integration (distinct from the catalog/warranty-push integration documented in [07-easygas-integration.md](07-easygas-integration.md)) — `warranty_equipment`'s `equipment_validation_status`, `validated_at`, `reward_points`, `reward_transaction_id`, `validation_response` columns are schema-ready but never populated by any code path.
- `warranty_form_products`, `warranty_forms`' original per-equipment flat columns, `vehicle_brand`/`vehicle_model`, `products.score`, `products.status` — all fully superseded, kept only so historical rows keep rendering or because migrations never drop columns.
- No "warranty validity" (active/expired/cancelled) concept exists anywhere, despite EasyGas's response already carrying `term_months`/`expires_at`/`status` on every successful push.

## Confirmed Broken

- The documented `create-admin.js` first-admin bootstrap script does not exist in the repository, despite being referenced by both `package.json` and `docs/deployment-guide.md`. **Unchanged this session** — confirmed still missing.

## Implemented But Currently Unreachable

New category this session, worth calling out on its own:

- **The typed-cylinder backend capability has no frontend to use it.** The form still hard-requires a catalog product for all 4 equipment types. See [05-frontend.md](05-frontend.md).
- **`branches.easygas_stag_code` has an API but no UI.** An admin can look up the real value (`GET /api/branches/easygas`) and set it (`PUT /api/branches/:branchId`), but only by calling the API directly — no form field exists yet.

## Known Limitations, Stated Directly

- No JWT refresh/revocation mechanism exists.
- There is no "warranty validity" concept anywhere — only sync status exists.
- Four of the seven `inventory_items` statuses (`RESERVED`, `RETURNED`, `DAMAGED`, `LOST`) have no automatic trigger — manual admin actions only.
- No incremental EasyGas catalog sync exists or is planned to be added — a deliberate choice, not a gap (see [07-easygas-integration.md](07-easygas-integration.md)).
- The frontend's EasyGas error-code translation dictionary is behind the backend's by 6 codes.
- No automated test suite exists anywhere in either repository — confirmed directly (no test files, no test runner dependency, no `test` script) in both a fresh backend and frontend audit this session.

## Code Quality Review

See [12-architecture-review.md](12-architecture-review.md) for the full, critical version. Short version: maintainability is high in the domains that received the most iteration (warranty, inventory, points, EasyGas sync) — real transaction discipline, one proven atomic-guard idiom reused everywhere, additive-only migrations with zero exceptions found, and an unusually high proportion of self-documenting comments explaining *why*, not just what. It's lower in domains touched less recently (`userController.js` bypasses the service/repository layers entirely) — a recognizable shape for a system that grew in phases, evidenced directly rather than assumed.

**Recommendation for anyone extending this codebase**: read `services/warrantyService.js` and `services/easyGasSyncService.js` first — between them they show both the intended architectural pattern and the most recently-exercised discipline of confirming an external contract empirically rather than trusting a document. Treat `userController.js` as an outlier, not an alternative style.
