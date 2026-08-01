# 11 — Planned Evolution (Not Yet Built)

[← Back to index](01-project-overview.md)

**Nothing in this file is implemented.** Everything here is either something a real party (you) has stated as a direction, or an obvious next step implied by a gap documented elsewhere in this folder. Each item is labeled with where it came from, so a future reader can judge how solid the ground under it is. If you're looking for what actually exists today, see [10-current-state.md](10-current-state.md) instead — do not treat anything below as current functionality.

## Near-term, high-confidence (implied directly by gaps already documented)

These aren't speculative — they're the direct, obvious follow-ups to gaps already documented:

1. **Frontend UI for the typed cylinder.** The backend fully supports a product-less cylinder (`services/warrantyService.js`, confirmed working); the frontend form has no way to produce one. This is the highest-value near-term item — a real backend capability is currently unreachable. See [05-frontend.md](05-frontend.md).
2. **Fix or retire `create-admin.js`.** Either restore the script or update `docs/deployment-guide.md` to document the direct-SQL bootstrap path explicitly — a fresh production deploy currently has no working first-admin path at all.

## Dormant schema, unclear timeline

- **The external STAG equipment-validation API** — `warranty_equipment`'s `equipment_validation_status`/`validated_at`/`reward_points`/`reward_transaction_id`/`validation_response` columns exist for this, entirely unpopulated. A separate, still-unbuilt integration — no timeline or contract exists for this one at all, as far as this documentation pass found.

## User-stated general direction — not grounded in any existing code, comment, or communication found this session

The following were named directly by you as future ERP direction, not derived from anything in the codebase. Flagging that distinction explicitly, per your own instruction not to blur current state with aspiration:

- Broader warehouse expansion beyond the current single-`branches`-as-warehouse model.
- A purchase/procurement module.
- Supplier management.
- Formal stock-movement tracking beyond the current inventory status-transition history.

None of these have any schema, code, comment, or prior design document behind them today. If and when work starts on any of them, this is the section to expand — not [10-current-state.md](10-current-state.md).
