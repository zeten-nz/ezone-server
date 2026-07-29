# 11 — Planned Evolution (Not Yet Built)

[← Back to index](01-project-overview.md)

**Nothing in this file is implemented.** Everything here is either something a real party (you, or EasyGas) has stated as a direction, or an obvious next step implied by a gap documented elsewhere in this folder. Each item is labeled with where it came from, so a future reader can judge how solid the ground under it is. If you're looking for what actually exists today, see [10-current-state.md](10-current-state.md) instead — do not treat anything below as current functionality.

## Near-term, high-confidence (implied directly by gaps already documented)

These aren't speculative — they're the direct, obvious follow-ups to capabilities that were only half-shipped this session:

1. **Frontend UI for the typed cylinder.** The backend fully supports a product-less cylinder (`services/warrantyService.js`, confirmed working); the frontend form has no way to produce one. This is the highest-value near-term item — a real backend capability is currently unreachable. See [05-frontend.md](05-frontend.md).
2. **Frontend error-code dictionary update.** Add the 6 new terminal EasyGas codes (`FIELD_REQUIRED`, `BRANCH_UNKNOWN`, `CAR_UNKNOWN`, `FUEL_TYPE_MISMATCH`, `COMPONENTS_INCOMPLETE`, `PHONE_INVALID`) to `config/errorCodes.js` so the admin Sync Status badge shows a specific translated reason instead of a generic fallback.
3. **Frontend UI for `branches.easygas_stag_code`.** The backend has a working admin endpoint (`GET /api/branches/easygas`) and field (`PUT /api/branches/:branchId`); no form field exists to use either. Without this, `branch_stag_code` stays null on every real push, which will terminally fail every warranty until populated.
4. **`vehicle_brand`/`vehicle_model` split input.** EasyGas requires these as separate free-text fields when no catalog `car_id` is chosen; this codebase only captures a single combined `vehicle_name` string in that case. A real product decision, not just a code change — see [07-easygas-integration.md](07-easygas-integration.md).
5. **Fix or retire `create-admin.js`.** Either restore the script or update `docs/deployment-guide.md` to document the direct-SQL bootstrap path explicitly — a fresh production deploy currently has no working first-admin path at all.

## Stated by EasyGas, not yet verified live or built

These come from EasyGas's own messages this session, some of which were later contradicted by live testing on other points (see [07-easygas-integration.md](07-easygas-integration.md)'s confidence key) — treat everything in this section as **unconfirmed** until it's tested the same rigorous way the payload shape was:

- **A durable, exponentially-backing-off retry queue** (proposed cadence: 1s→4s→15s→1m→5m→30m, capped ~24h), replacing the current flat-interval-forever retry sweep. The current sweep is already crash-safe and retries without limit — functionally durable, just not exponential. A real architectural change, not a quick add.
- **Two customer/branch-facing read screens**: a "verification" lookup (by phone/VIN/serial) and a "branch bonus" balance view, backed by EasyGas read endpoints that were never confirmed to exist against the live API this session.
- **A `claim_url`/live-status QR concept** for customers — mentioned in an early integration-brief document, never seen in any real response this session, not implemented.
- **EasyGas becoming the customer-facing source of truth for live warranty status** — plausible given they mint the warranty number and (per their own statement) plan to serve customers directly, but EZONE has built nothing toward this and has no "warranty validity" concept to hook it into yet.
- **`SERIAL_UNKNOWN`/`SERIAL_PRODUCT_MISMATCH` going live** — EasyGas's own note says these activate in stages as their genuine-serials list and product-serial mapping are backfilled; this codebase already handles both identically to the currently-live `SERIAL_ALREADY_USED`, so no code change is needed when they switch on — included here only so a future reader isn't surprised when they start appearing.

## Dormant schema, unclear timeline

- **The external STAG equipment-validation API** — `warranty_equipment`'s `equipment_validation_status`/`validated_at`/`reward_points`/`reward_transaction_id`/`validation_response` columns exist for this, entirely unpopulated. Distinct from the catalog/warranty-push integration documented in [07-easygas-integration.md](07-easygas-integration.md) — no timeline or contract exists for this one at all, as far as this documentation pass found.

## User-stated general direction — not grounded in any existing code, comment, or communication found this session

The following were named directly by you as future ERP direction, not derived from anything in the codebase. Flagging that distinction explicitly, per your own instruction not to blur current state with aspiration:

- Broader warehouse expansion beyond the current single-`branches`-as-warehouse model.
- A purchase/procurement module.
- Supplier management.
- Formal stock-movement tracking beyond the current inventory status-transition history.

None of these have any schema, code, comment, or prior design document behind them today. If and when work starts on any of them, this is the section to expand — not [10-current-state.md](10-current-state.md).
