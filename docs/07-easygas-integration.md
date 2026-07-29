# 07 — EasyGas / STAG Integration

[← Back to index](01-project-overview.md)

This is the most-changed part of the system since the previous documentation pass. Everything below reflects the state after: switching the catalog client from a separate unsigned public API to the same HMAC-signed API as the warranty push, fixing a pagination bug that was silently capping every catalog sync at page 1, adding cross-worker coordination and deletion detection to the catalog sweep, confirming the real warranty-push payload shape through live testing (correcting an earlier wrong assumption along the way), adding a `branch_stag_code` admin lookup, and adding support for a free-text ("typed") cylinder.

**Confidence key used throughout this file:**
- **Confirmed live** — proven against `admin.stag.uz`'s real signed API this session, not assumed from a document.
- **Implemented** — real, shipped code, but never exercised against a real successful (`2xx`) warranty push; every live test so far has been a deliberate synthetic-data rejection test.
- **Unconfirmed / not implemented** — mentioned in an EasyGas-provided document at some point but never verified live and not built. Listed in [11-roadmap.md](11-roadmap.md), not here.

## Who Owns What

| Concern | Owner | Detail |
|---|---|---|
| The installation event (who installed what, on which vehicle, which physical barcoded unit) | **EZONE** | `warranty_forms` + `warranty_equipment`, created synchronously, never overwritten by sync |
| Installer reward points | **EZONE** | Entirely local — `point_transactions`, never sent to or derived from EasyGas |
| The official warranty number | **STAG (EasyGas)** | EasyGas mints a 14-digit code and returns it; EZONE only stores what's returned (`easygas_warranty_number`/`warranty_book_number`), never generates one itself |
| Warranty term/expiry/live status | **STAG (EasyGas)**, per their own stated direction | Not implemented or read by EZONE at all today — no "warranty validity" concept exists anywhere in this schema, only sync status |
| The equipment catalog (brands/products/cars) | **STAG (EasyGas)**, mirrored into EZONE | EZONE's `products`/`brands`/`cars` tables are a read-only mirror, refreshed by a full pull every sync cycle |
| The branch STAG code (`branch_stag_code`, e.g. `"01/1"`) | **STAG (EasyGas)**, manually copied into EZONE | EZONE has no way to derive this automatically — an admin looks it up via a live passthrough and enters it by hand |
| Serial/genuine-unit validation | **STAG (EasyGas)**, partially rolled out | `SERIAL_ALREADY_USED` is live; `SERIAL_UNKNOWN`/`SERIAL_PRODUCT_MISMATCH` are handled identically already, in case EasyGas activates them without warning |

The one-sentence version: **EZONE decides what happened; STAG decides what it officially means.**

## Outbound Only, Two Independent Loops — Never Inbound

No webhook/inbound-push route exists anywhere; this app never receives a call from EasyGas.

## Warranty Push (private, HMAC-signed)

The business-critical direction: pushing a submitted warranty to EasyGas so it can issue an official warranty number.

**Authentication**: HMAC-SHA256 over `${timestamp}.${rawBody}` using a shared secret (`EASYGAS_SHARED_SECRET`), sent as `X-EG-Timestamp`/`X-EG-Signature: sha256=<hex>` headers — confirmed live (a deliberately wrong secret would 401; the real one reaches real field-validation errors instead). Signing logic lives in `utils/easyGasSigning.js`, shared by both the warranty client and the catalog client (extracted this session — previously private to the warranty client alone).

### Payload shape — confirmed live, corrected once during this session

```json
{
  "submission_uuid": "...", "external_ref": 123,
  "branch_stag_code": "01/1", "fuel_type": "cng",
  "installer_full_name": "...", "organization_name": "...", "organization_phone": "+998...",
  "installation_date": "2026-01-01", "region": "...", "city": "...", "district": "...",
  "car_id": 27, "vehicle_production_year": 2020, "vehicle_plate_number": "...",
  "vehicle_vin": "...", "vehicle_mileage": 12000,
  "owner_full_name": "...", "owner_phone": "+998...",
  "components": [
    { "component_type": "reducer", "product_id": 500, "serial_number": "..." },
    { "component_type": "cylinder", "product_id": 215, "serial_number": "..." },
    { "component_type": "controller", "product_id": 27, "serial_number": "..." },
    { "component_type": "injector", "product_id": 900, "serial_number": "..." }
  ]
}
```

Built by `buildPayload` in `services/easyGasSyncService.js`. Every field above is **confirmed live**, not inferred — the previous documentation pass flagged this whole payload as "an inferred guess, unconfirmed against a real schema." That flag is now resolved, with one real correction along the way worth recording honestly: a controlled A/B test (same payload, once with a flat `<type>_product_id`-per-field shape, once with the nested `components` array above) proved the nested array is what EasyGas actually reads as input — an earlier documented conclusion, drawn from seeing flat field names in an *error response*, had it backwards. The flat names seen in error bodies (e.g. `"field": "cylinder_product_id"`) are EasyGas's error-**display** convention only, decoupled from the actual request shape.

Fields *not* sent, on purpose:
- `installer_phone` — doesn't appear in EasyGas's confirmed field list, only `installer_full_name` does.
- `vehicle_brand`/`vehicle_model` — see [Known Gap](#known-gap-vehicle_brandvehicle_model) below.

### The cylinder component — open input as of this session

EasyGas's catalog only carries 2 CNG cylinder models — not enough for what installers actually fit — so **the cylinder, and only the cylinder**, can now be submitted as free text instead of a catalog pick:

```json
{ "component_type": "cylinder", "brand_name": "Shermatov Gas", "model": "65 l", "serial_number": "CYL-SN-1001" }
```
`model` is required when `product_id` is absent (a bare `"model": "100 l"` with no brand/serial is also valid); `brand_name`/`serial_number` are always optional for a typed cylinder. Reducer/controller/injector are unaffected — always a real catalog `product_id` + serial.

**Confirmed live** as EasyGas's contract. **Implemented** in `resolveEquipment` (`services/warrantyService.js`), `warranty_equipment.product_id` (now nullable) + new `brand_name`/`model` columns, and `buildPayload`'s per-component branch. **Not usable yet** — see the frontend gap below.

### `branch_stag_code` — a real data gap, not just a code gap

`warranty_forms.installer_branch_code` (a frozen snapshot of the submitting branch, taken at submission time) is joined against `branches.easygas_stag_code` to build this field. The join is correct and live; **the data behind it usually isn't there yet** — `branches.easygas_stag_code` is a new, nullable column with no automatic population path. `GET /api/branches/easygas` (admin-only) is a live, uncached passthrough of EasyGas's real branch list (`{stag_code, name, region_id}`) so an admin can look up the right value and enter it via `PUT /api/branches/:branchId` — but nobody has done this for real branches yet, and no frontend field exists to enter it through (see [05-frontend.md](05-frontend.md)).

### Known gap: `vehicle_brand`/`vehicle_model`

EasyGas requires these two free-text fields *only* when `car_id` is null (their fallback for a car not in their ~400-car catalog). This codebase has no split brand/model capture for that case — only a combined `vehicle_name` string. A submission with no catalog car match will get `FIELD_REQUIRED` from EasyGas until this is addressed, most likely by adding two real input fields to the frontend's car-fallback path. Deliberately not worked around by guessing a split of `vehicle_name` — see [11-roadmap.md](11-roadmap.md).

### Response — confirmed live

```json
{ "success": true, "warranty": { "warranty_book_number": "10293847561234", "fuel_type": "cng", "term_months": 24, "km_limit": 40000, "installation_date": "...", "expires_at": "...", "status": "active" } }
```
`classifyResult` reads `result.data?.warranty?.warranty_book_number` (nested — an earlier assumption of a top-level `warranty_number` field was wrong and has been fixed). `easyGasSyncSweep.js`'s `applyOutcome` writes that value into **both** `easygas_warranty_number` and the legacy `warranty_book_number` column. `term_months`/`km_limit`/`expires_at`/`status` are received but **not currently stored or displayed anywhere** — EZONE has no "warranty validity" concept to put them in yet.

### Retry classification (`classifyResult`)

- **Retryable**: network errors, HTTP `5xx`, HTTP `401`/`403` (explicit — a persistent auth failure is a global config problem, not a per-warranty one; retrying costs nothing and self-heals the moment ops fixes the secret), and two EasyGas-documented safe-to-retry codes (`DUPLICATE_SUBMISSION`, `CONFLICT`).
- **Terminal** (never auto-retried): `PRODUCT_UNKNOWN`, `FIELD_TOO_LONG`, `INVALID_VALUE`, `INVALID_DATE`, `WARRANTY_LOCKED`, `SERIAL_ALREADY_USED`, `SERIAL_UNKNOWN`, `SERIAL_PRODUCT_MISMATCH`, plus `FIELD_REQUIRED`, `BRANCH_UNKNOWN`, `CAR_UNKNOWN`, `FUEL_TYPE_MISMATCH`, `COMPONENTS_INCOMPLETE`, `PHONE_INVALID` (all added this session, matching EasyGas's own error-code table) and a locally-detected `PRODUCT_NOT_MAPPED` when equipment has no EasyGas catalog match at all.
- **No maximum attempt cap** — deliberate: an EasyGas outage should keep quietly retrying, never silently give up.
- A typed cylinder is never treated as "unmapped" by `findUnmappedEquipmentType` — it was never supposed to have a catalog match in the first place.

### Idempotent create

`submission_uuid` is generated client-side once (`crypto.randomUUID()`) and reused across every retry/edit — confirmed both server-side (the column simply isn't in the `UPDATE`'s SET clause, so an edit can't overwrite it even if it tried) and client-side (the frontend's `createEmptyWarrantyForm()` only mints a fresh one on genuinely new forms). As of this session, retrying `POST /api/warranty` with the same `submission_uuid` returns the already-created form (`200`, not `201`) instead of a raw `ER_DUP_ENTRY` 500 — checked via `warrantyRepository.findBySubmissionUuid` before any expensive work (barcode validation, inventory claim, points award), with a second check after a lost INSERT race for two near-simultaneous retries.

## Catalog Pull — now signed, same base/secret as the warranty push

**This changed structurally this session.** Previously a separate "public, unsigned" API with its own base URL; EasyGas asked for it to move behind the same signed endpoints as the warranty push, and it now does (`services/easyGasCatalogClient.js`). `EASYGAS_CATALOG_API_BASE_URL` is retired.

Confirmed live, real fields:
- `GET /branches` → `{stag_code, name, region_id}`, small unpaginated list.
- `GET /products?component_type=&brand_id=&fuel_type=&page=&per_page=` → paginated (max `per_page=100`), each row carrying `product_category_id`, **`component_type`** (pre-resolved by EasyGas — `"controller"` etc., so this app never has to hardcode their category ids for this purpose), **`station_type`** (`'metan'`/`'propan'`/`'Metan va Propan'` → mapped to `CNG`/`LPG`/`NULL`-meaning-fuel-agnostic), `product_brand_id`, `updated_at`.
- `GET /cars?q=&page=&per_page=` → paginated, `{id, name, brand_name, updated_at}`.
- `GET /brands` → small unpaginated list.

### A real bug this session found and fixed: pagination

`walkPaginatedCatalog` read `result.data?.meta?.last_page` — correct for the *old* public API's response shape, but the new signed endpoint returns a standard flat Laravel `paginate()` response (`{current_page, data, last_page, per_page, total, ...}`, no `meta` wrapper at all). `meta` was always `undefined`, so `lastPage` always defaulted to `1` — **every sync was silently capped at page 1** (100 of ~179 products; 100 of ~409 cars) until this was caught and fixed. Confirmed fixed: a manual full sync after the fix imported 108 products (of 179 total; 68 skipped for unmapped category, 3 for unresolved brand — accounted for, not lost) and all 409 cars.

### No incremental sync — deliberately, not by oversight

`updated_since` is computed as a real, working parameter but **never sent**. This is the one place worth being blunt about a premise correction: EasyGas's catalog has no soft-deletes, so a deleted product can never appear in an `updated_since`-filtered response at all — there's no row left to carry a timestamp. Only a full walk, diffed against what's already stored locally, can notice a deletion. Every sync cycle (`EASYGAS_CATALOG_SYNC_INTERVAL_MS`, default 5 minutes) therefore does a complete walk of every page, not an incremental one. This is *not* "nightly" — it's considerably more frequent than that, which more than covers EasyGas's own suggestion of nightly-at-minimum.

### Deletion detection (new this session)

After a full walk completes successfully, any local product/car whose `external_id IS NOT NULL` and whose `synced_at` predates this cycle's start is marked `is_active = FALSE` — it genuinely wasn't in the pull, so it's gone. Re-upserting (`ON DUPLICATE KEY UPDATE ... is_active = TRUE`) correctly reactivates a row that reappears later. `resolveEquipment` already rejects an inactive product and `productRepository.search`/`carRepository.search` already filter to `is_active = TRUE`, so this alone stops a vanished product/car from being used in a new warranty — no other code needed to change.

Guarded on the walk having completed fully (`walk.ok`) — a network hiccup mid-walk never triggers a false mass-deactivation. The cycle's start time is read via `SELECT NOW()` on the same connection, not `new Date()` in Node — worth recording why: an ad-hoc test connection without this app's `timezone: '+00:00'` pool setting mismatched a JS-Date parameter against stored `TIMESTAMP` values badly enough to mark every just-synced row "stale" in the very cycle it was upserted. Sourcing the timestamp from MySQL itself makes the comparison self-consistent regardless of the calling connection's timezone assumption — caught and fixed the same session it was introduced.

## Crash Recovery

Any warranty stuck in `SYNCING` for more than 5 minutes (a worker crashed mid-push) is automatically reaped back to `PENDING` at the start of every warranty-sweep cycle, on every PM2 worker.

## Cluster-Mode Coordination — both sweeps now have it

- **Warranty push sweep**: atomic per-row claim (`UPDATE ... WHERE status='PENDING'`, checked via `affectedRows`) — every PM2 worker runs its own copy; without the claim, two workers could push the same warranty twice.
- **Catalog sweep**: previously had none at all — every PM2 worker independently re-pulled the entire catalog on the same interval, a real amplification concern against EasyGas's own API. **As of this session, gated to PM2 worker `0` only** (`process.env.NODE_APP_INSTANCE`, which PM2 cluster mode sets per worker; `undefined` outside cluster mode/local dev always runs it, since there's only one process). This is whole-sweep gating, not per-row — appropriate here since a catalog upsert has no per-row race to guard, unlike the warranty push.

## Error Surfacing to Admins

`easygas_last_error` (truncated to 255 chars) always leads with a recognizable code token (`CODE: detail`) so the admin UI's Sync Status badge can parse it and show a translated reason via `config/errorCodes.js`. **As of this session, the frontend's error-code dictionary has not been updated** for the 6 new terminal codes above — they'll fall through to a generic translated message rather than a specific one until that catches up (see [11-roadmap.md](11-roadmap.md)). Admins can manually reset a `FAILED` row via `POST /api/warranty/:formId/retry-sync` (409 if not currently FAILED), including terminal failures once the underlying issue is fixed elsewhere.

## Summary Table

| Direction | API | Auth | Trigger | Coordination across PM2 workers |
|---|---|---|---|---|
| Outbound push | Warranty submission | HMAC-SHA256 | Background sweep, every 30s (`EASYGAS_SYNC_INTERVAL_MS`) | Atomic per-row claim |
| Outbound pull | Catalog (brands/products/cars/branches) | HMAC-SHA256 (same secret/base as push, changed this session) | Background sweep, every 5min (`EASYGAS_CATALOG_SYNC_INTERVAL_MS`), always a full walk | Whole-sweep gate to worker 0 (new this session) |
| Inbound | — | — | — | **Does not exist** — no webhook/inbound route anywhere |

## What Has Never Been Verified Live

Listed here explicitly so "confirmed" isn't overstated elsewhere in this file:
- A real, successful (`2xx`) warranty push — every live test to date has deliberately used synthetic data expected to be rejected (fake product/car ids, no real `branch_stag_code` yet).
- Whether `SERIAL_UNKNOWN`/`SERIAL_PRODUCT_MISMATCH` actually fire yet on EasyGas's side (per their own note, rolled out in stages).
- `claim_url`, a customer-facing QR/live-status page, the two "read screens" (verification, branch bonus), and a durable exponential-backoff retry queue — mentioned in an early integration-brief document of mixed reliability, never tested, not built. See [11-roadmap.md](11-roadmap.md).
