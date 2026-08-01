# 12 — Architecture Review

[← Back to index](01-project-overview.md)

A critical, senior-level assessment. Deliberately not balanced toward praise — where something is genuinely well-built, it's said once and moved past; more space is given to what's fragile, missing, or worth reconsidering. Everything below is grounded in direct code reading and this session's own live testing, not general best-practice platitudes.

## Strengths (stated briefly, not the point of this document)

Real transaction discipline everywhere money/inventory is touched. One atomic-guard idiom (`UPDATE ... WHERE id=? AND status=?`, check `affectedRows`) reused consistently rather than reinvented per feature. Migrations are additive-only with zero exceptions found across the whole file. An unusually high proportion of code comments explain *why*, not *what*.

## Weaknesses

- **Layering is not applied uniformly.** `userController.js` bypasses service/repository entirely; branches and products do so partially. A new engineer reading `warrantyService.js` first and assuming it represents "how this codebase works" will be surprised by `userController.js`.
- **The DTO pattern exists for exactly one domain.** `dtos/warrantyDTO.js` shapes warranty responses; every other domain returns raw database rows directly to the client, including internal column names and NULL-heavy legacy fields.
- **Two independent export systems** (legacy in-memory XLSX, newer streamed CSV) with separate label dictionaries, separate localization mechanisms (query param vs. header), and no shared code at all. Functionally justified originally, but it's a maintenance tax that compounds — a bilingual label change now has to happen in two places, and nothing enforces that both get updated.

## Technical Debt

- **Dead/dormant columns accumulate with no cleanup path.** `products.score`, `products.status`, `warranty_form_products`, the legacy flat equipment columns on `warranty_forms`, `cars.external_updated_at`, plus the full set of now-deprecated columns from the removed third-party sync integration (legacy sync-tracking fields on `warranty_forms`, a STAG-branch-code field on `branches`, `external_id`/`synced_at` on `products`/`brands`/`cars`) — none of these will ever be removed under the current additive-only migration philosophy. That philosophy is exactly right for production safety, but nothing balances it with an eventual, deliberate cleanup migration for columns confirmed dead for a long time. The schema will only ever grow — the recent third-party integration removal itself is a fresh, large example: a full external integration ripped out of the code, and every column it ever wrote still sits in the schema, now permanently inert until a deliberate Phase 2 migration.
- **`config/database.js` is a single, very large, linear file** running synchronously at every boot, with no version history beyond what `information_schema` happens to show right now. There's no way to know *when* a given migration ran, no rollback capability, and no way to run migrations independently of a full app boot. This has worked so far because the team writing it has been disciplined — but discipline is not a substitute for a migration framework once more than one person is regularly touching schema.
- **The frontend/backend contract has no shared source of truth.** No OpenAPI spec, no generated types, no shared validation schema between `routes/warrantyRoutes.js`'s express-validator rules and the frontend's zod schemas — this will keep causing drift, on some field, indefinitely, without a shared contract.

## Scalability

- **PM2 cluster mode + a single MySQL instance** is appropriate for the current apparent scale (a few hundred warranties observed, a few dozen branches) but has no documented path forward — no read-replica strategy, no discussion of `DB_POOL_SIZE` (flat default of 10) under real concurrent load, no query-level slow-log review evidenced anywhere.
- **Points balance is always computed live via `SUM(points)`** — the right call for correctness (no cache-drift class of bugs), but it means an installer with years of history pays a real, unindexed-beyond-the-basics aggregation cost on every ledger view. Fine today; worth watching as `point_transactions` grows.

## Maintainability

Highest in the domains that have been iterated on most (warranty, inventory, points) — lowest in `userController.js` and the export-system duplication. The gap between these two ends is widening, not narrowing, because the well-maintained domains keep receiving careful attention while the plainer domains receive none. Over time this makes the "read the warranty domain to learn the house style" recommendation ([10-current-state.md](10-current-state.md)) less useful, since a growing share of the codebase won't match it.

## Risks

1. **No automated test suite anywhere, in either repository, for a system handling warranty legal documents and a real financial ledger.** Regressions are caught only by manual, ad-hoc verification — real, careful verification, but not repeatable, not run on every change, and entirely dependent on someone remembering to do it. That is a real, standing risk for a system of this consequence.
2. **First-admin bootstrap is genuinely broken** (`create-admin.js` missing) — a real deployment risk for any future fresh environment, not just a documentation nit.
3. **Secret handling is manual and undocumented beyond "put it in `.env`."** No secrets-manager integration, no rotation runbook.

## Missing Abstractions

- **No service/repository layer for users**, unlike every other domain.
- **No shared validation contract** between backend (express-validator) and frontend (zod) — see Technical Debt above.

## Possible Simplifications

- **Collapse the two export systems into one**, or at minimum share the label dictionaries (`config/csvLabels.js` vs. `excelController.js`'s local `EXCEL_FIELD_LABELS`) so a translation only has to be added once.
- **Bring `userController.js` in line with the layered pattern** — it's a small, well-scoped piece of work relative to the consistency it would buy.
- **Retire fully-dead columns in one deliberate, explicitly-destructive migration**, reviewed and approved as an exception to the additive-only rule, rather than letting them accumulate forever. `products.score`, `products.status`, `cars.external_updated_at` are strong candidates — confirmed dead, not merely legacy-for-display. The full set of now-deprecated columns from the removed third-party sync integration (legacy sync-tracking fields on `warranty_forms`, a STAG-branch-code field on `branches`, `external_id`/`synced_at` on `products`/`brands`/`cars`) is the largest and most obvious candidate — a Phase 2 cleanup migration for these is already anticipated, just not yet scheduled.

## Future Improvements (engineering, not product roadmap — see [11-roadmap.md](11-roadmap.md) for product/feature direction)

1. Add automated tests for the domains that would hurt the most to get wrong silently: warranty creation's transaction/claim logic and the points award/reversal ledger.
2. Introduce a real migration framework or at minimum a version-tracked migration log, before `config/database.js` grows further — it has already grown considerably across this project's life and shows no sign of slowing.
3. Execute the planned Phase 2 migration to drop the deprecated columns left behind by the removed third-party sync integration (legacy sync-tracking fields on `warranty_forms`, a STAG-branch-code field on `branches`, `external_id`/`synced_at` on `products`/`brands`/`cars`) once their absence is confirmed safe.
