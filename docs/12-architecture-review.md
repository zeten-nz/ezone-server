# 12 — Architecture Review

[← Back to index](01-project-overview.md)

A critical, senior-level assessment. Deliberately not balanced toward praise — where something is genuinely well-built, it's said once and moved past; more space is given to what's fragile, missing, or worth reconsidering. Everything below is grounded in direct code reading and this session's own live testing, not general best-practice platitudes.

## Strengths (stated briefly, not the point of this document)

Real transaction discipline everywhere money/inventory is touched. One atomic-guard idiom (`UPDATE ... WHERE id=? AND status=?`, check `affectedRows`) reused consistently rather than reinvented per feature. Migrations are additive-only with zero exceptions found across the whole file. An unusually high proportion of code comments explain *why*, not *what* — and this session's own EasyGas work continued that discipline (the pagination-bug comment, the timezone-comparison comment, the nested-components comment all explain a real incident, not a hypothetical one).

## Weaknesses

- **Layering is not applied uniformly.** `userController.js` bypasses service/repository entirely; branches and products do so partially. A new engineer reading `warrantyService.js` first and assuming it represents "how this codebase works" will be surprised by `userController.js`.
- **The DTO pattern exists for exactly one domain.** `dtos/warrantyDTO.js` shapes warranty responses; every other domain returns raw database rows directly to the client, including internal column names and NULL-heavy legacy fields.
- **Two independent export systems** (legacy in-memory XLSX, newer streamed CSV) with separate label dictionaries, separate localization mechanisms (query param vs. header), and no shared code at all. Functionally justified originally, but it's a maintenance tax that compounds — a bilingual label change now has to happen in two places, and nothing enforces that both get updated.
- **This session's own EasyGas work is itself evidence of a process gap**: the *only* way this system verifies its contract with EasyGas is a human (me, this session) manually running one-off scripts and reading responses. There is no repeatable, automated contract test. If EasyGas changes their API again — and this session proved they already have, twice, without much warning — nothing catches it except another manual investigation. This is not a hypothetical risk; it already happened once this session (the nested-components shape) and the resolution depended entirely on someone thinking to run a controlled A/B test rather than trusting a document.

## Technical Debt

- **Dead/dormant columns accumulate with no cleanup path.** `products.score`, `products.status`, `warranty_form_products`, the legacy flat equipment columns on `warranty_forms`, `cars.external_updated_at` — none of these will ever be removed under the current additive-only migration philosophy. That philosophy is exactly right for production safety, but nothing balances it with an eventual, deliberate cleanup migration for columns confirmed dead for a long time. The schema will only ever grow.
- **`config/database.js` is a single, very large, linear file** running synchronously at every boot, with no version history beyond what `information_schema` happens to show right now. There's no way to know *when* a given migration ran, no rollback capability, and no way to run migrations independently of a full app boot. This has worked so far because the team writing it has been disciplined — but discipline is not a substitute for a migration framework once more than one person is regularly touching schema.
- **`EASYGAS_SHARED_SECRET` is a single secret used for both the warranty push and the catalog pull, with no rotation plan or overlap window.** A compromise of one exposes both; rotating it requires a hard cutover, not a graceful one.
- **The frontend/backend contract has no shared source of truth.** No OpenAPI spec, no generated types, no shared validation schema between `routes/warrantyRoutes.js`'s express-validator rules and the frontend's zod schemas. The error-code dictionary drift found this session (backend has 6 codes the frontend doesn't know about) is a direct symptom — this will keep happening, on some field, indefinitely, without a shared contract.

## Scalability

- **PM2 cluster mode + a single MySQL instance** is appropriate for the current apparent scale (a few hundred warranties observed, a few dozen branches) but has no documented path forward — no read-replica strategy, no discussion of `DB_POOL_SIZE` (flat default of 10) under real concurrent load, no query-level slow-log review evidenced anywhere.
- **Points balance is always computed live via `SUM(points)`** — the right call for correctness (no cache-drift class of bugs), but it means an installer with years of history pays a real, unindexed-beyond-the-basics aggregation cost on every ledger view. Fine today; worth watching as `point_transactions` grows.
- **An unverified assumption in the newly-added catalog-sweep worker gating**: `NODE_APP_INSTANCE` is documented (by the code's own comment) as "stable for the cluster's lifetime, reset only by a fresh `pm2 start`, not an individual worker crash+respawn." This session did not verify what happens if PM2 respawns worker 0 specifically after a crash — whether the respawned process keeps instance id `'0'` or not. If it doesn't, the catalog sync silently stops entirely until the next full `pm2 start`; if some other race assigns `'0'` to two processes momentarily, the sweep briefly loses its coordination guarantee. This is exactly the kind of assumption this session's own EasyGas work showed the danger of trusting without testing — it should be verified against a real PM2 crash/respawn, not assumed.

## Maintainability

Highest in the domains that have been iterated on most (warranty, inventory, points, EasyGas sync) — lowest in `userController.js` and the export-system duplication. The gap between these two ends is widening, not narrowing, because the well-maintained domains keep receiving careful attention (this session added meaningfully to warranty/EasyGas) while the plainer domains receive none. Over time this makes the "read the warranty domain to learn the house style" recommendation ([10-current-state.md](10-current-state.md)) less useful, since a growing share of the codebase won't match it.

## Risks

1. **No automated test suite anywhere, in either repository, for a system handling warranty legal documents and a real financial ledger.** Every regression this session was caught by manual, ad-hoc verification — real, careful verification, but not repeatable, not run on every change, and entirely dependent on someone remembering to do it. A single missed manual check (and this session had at least one close call — the deletion-detection timezone bug, caught only because a test happened to use a differently-configured connection) is a real, standing risk.
2. **Silent EasyGas contract drift.** No alerting exists if the sync success rate drops, if a new EasyGas error code starts appearing that nothing classifies, or if the catalog sweep stops running entirely (e.g. the worker-0 assumption above failing silently). Everything currently surfaces via `console.log`/`console.warn` into PM2 logs — nothing pages anyone.
3. **First-admin bootstrap is genuinely broken** (`create-admin.js` missing) — a real deployment risk for any future fresh environment, not just a documentation nit.
4. **Secret handling is manual and undocumented beyond "put it in `.env`."** No secrets-manager integration, no rotation runbook, no dual-secret transition support.

## Missing Abstractions

- **No generic signed-HTTP-client abstraction.** `easyGasWarrantyClient.js` and `easyGasCatalogClient.js` now share signing (`utils/easyGasSigning.js`, extracted this session) but still duplicate the same request/response/timeout/never-rejects boilerplate independently. A single parameterized client (base URL + secret + method-specific paths) would remove the duplication and make a third signed integration cheap to add.
- **No service/repository layer for users**, unlike every other domain.
- **No shared validation contract** between backend (express-validator) and frontend (zod) — see Technical Debt above.
- **No abstraction over "the catalog might be temporarily wrong."** `resolveEquipment`/`productRepository.search` correctly filter `is_active`, but nothing distinguishes "genuinely retired" from "momentarily deactivated by a sync cycle that raced with a real catalog update" — both look identical to a technician mid-form-fill.

## Possible Simplifications

- **Collapse the two export systems into one**, or at minimum share the label dictionaries (`config/csvLabels.js` vs. `excelController.js`'s local `EXCEL_FIELD_LABELS`) so a translation only has to be added once.
- **Bring `userController.js` in line with the layered pattern** — it's a small, well-scoped piece of work relative to the consistency it would buy.
- **Retire fully-dead columns in one deliberate, explicitly-destructive migration**, reviewed and approved as an exception to the additive-only rule, rather than letting them accumulate forever. (`products.score`, `products.status`, `cars.external_updated_at` are strong candidates — confirmed dead, not merely legacy-for-display.)

## Future Improvements (engineering, not product roadmap — see [11-roadmap.md](11-roadmap.md) for product/feature direction)

1. Add automated tests for the domains that would hurt the most to get wrong silently: warranty creation's transaction/claim logic, the points award/reversal ledger, and `classifyResult`'s retry/terminal classification (the last one is pure, dependency-free, and would be nearly free to unit test today).
2. Add a repeatable, non-manual EasyGas contract check — even a scheduled version of `test-easygas-connection.js` that alerts on an unexpected response shape would have caught this session's nested-components surprise automatically instead of by chance.
3. Verify the PM2 worker-0 respawn assumption directly (kill worker 0 under load, confirm the catalog sweep either migrates correctly or fails loudly rather than silently).
4. Introduce a real migration framework or at minimum a version-tracked migration log, before `config/database.js` grows further — it has already grown considerably across this project's life and shows no sign of slowing.
5. Add basic alerting on sync health (EasyGas push success rate, catalog sync last-success timestamp) — the data to compute both already exists (`dashboard-totals`' `warrantySuccessRate`, `sync_state.last_synced_at`); nothing currently watches it proactively.
