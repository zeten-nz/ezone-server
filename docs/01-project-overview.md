# EZONE Warranty ERP — Project Documentation

This documentation was rewritten from a full re-read of the current codebase — both `ezone-server` (backend) and `ezone` (frontend), two separate git repositories under one non-repo parent folder — after a significant EasyGas integration overhaul. Every claim traces to an actual file, a live test performed against the real EasyGas API this session, or is explicitly labeled as unconfirmed/planned. Where the previous documentation pass turned out to be wrong, that's stated directly rather than silently corrected.

## Documentation Index

| File | Covers |
|---|---|
| [01-project-overview.md](01-project-overview.md) | This file — what the system is, who uses it, how EZONE and STAG/EasyGas divide responsibility |
| [02-architecture.md](02-architecture.md) | Technology stack, folder structure |
| [03-database.md](03-database.md) | Every table, relationship, index, migration — Live/Legacy/Dormant/Dead status per column |
| [04-backend.md](04-backend.md) | Auth, backend layering, warranty/inventory/points/reporting systems, background jobs |
| [05-frontend.md](05-frontend.md) | React app structure, and where it hasn't caught up with the backend |
| [06-api.md](06-api.md) | Complete HTTP endpoint reference |
| [07-easygas-integration.md](07-easygas-integration.md) | The EasyGas/STAG integration in full — what's confirmed live vs. implemented-but-unproven vs. unconfirmed |
| [08-deployment.md](08-deployment.md) | Environment variables, PM2/Nginx/SSL, deployment steps |
| [09-security.md](09-security.md) | Security measures implemented, known gaps, and a real PII leak found and fixed this session |
| [10-current-state.md](10-current-state.md) | What's finished, dormant, broken, or implemented-but-unreachable, as of today |
| [11-roadmap.md](11-roadmap.md) | Planned evolution only — clearly separated from current state, each item labeled by source |
| [12-architecture-review.md](12-architecture-review.md) | A critical, senior-level engineering assessment — strengths, debt, risk, not a sales pitch |

---

## 1. What This Project Is

A business system for **automotive LPG/CNG gas-conversion equipment** (reducers, cylinders, controllers, injector rails) sold under the STAG brand, used by a distributed network of installer branches to:

- Register vehicle gas-conversion warranties
- Track physical inventory of the equipment (barcoded units)
- Reward installers with points for installs
- Push warranty and catalog data to and from an external partner system, **EasyGas** (also referred to as **STAG** in partner communications — the same integration, two names)

## 2. Who Uses It

Two roles (`users.role ENUM('ADMIN','EMPLOYEE')`), plus an additive **Super Admin** flag on top of `ADMIN`:

- **EMPLOYEE** — installer/branch technician. Submits warranty forms, views own history/points/statistics.
- **ADMIN** — manages users, branches, product catalog, inventory, reviews reports.
- **Super Admin** — the tier reserved for the two actions with the most blast radius: configuring per-product point values, and correcting inventory records by hand.

New employees don't land directly in `users` — they submit a `registration_requests` row that an admin must explicitly approve.

## 3. Major Workflows

**Warranty creation**: an EMPLOYEE submits vehicle/owner data plus 4 fixed equipment slots. As of this session, the cylinder slot can also be free-typed (brand + capacity) instead of picked from the catalog — see §4 below. Each real (non-typed) slot's barcode is validated against physical inventory and atomically claimed, all inside one transaction. The warranty then sits `PENDING` for EasyGas sync — the actual push is never done inline, only by a background job, specifically so a partner-API failure can never crash or block a warranty submission. Retrying the same submission (the same `submission_uuid`) is safe — it returns the existing form rather than creating a duplicate.

**Inventory management**: admins bulk-import physical barcoded units per product via CSV; installers consume ("claim") them at submission time; admins can manually correct, transfer, or merge records, all audited.

**Points**: installers automatically earn points per equipment slot installed, if a point value is configured for that product — never a manual "claim" action. Reversed automatically on edit/delete. A typed cylinder always earns 0 points, since there's no catalog product to configure a value against.

## 4. Who Owns What — EZONE vs. STAG/EasyGas

This is the single most important thing to understand correctly, and the place the previous documentation pass was least precise:

| | EZONE | STAG / EasyGas |
|---|---|---|
| **Owns** | The installation event — who installed what, on which vehicle, which physical barcoded unit, installer reward points | The official warranty number, the equipment/vehicle catalog, (stated direction, unconfirmed) live warranty status for customers |
| **Never touches** | Warranty validity/expiry (no such concept exists in EZONE at all) | Which physical barcode was claimed, installer points |
| **Synchronizes with the other** | Pushes every submitted warranty outbound; mirrors the catalog inbound | Returns a warranty number EZONE stores back; nothing flows inbound beyond that — **no webhook, no inbound route exists at all** |

EZONE decides *what happened*. STAG decides *what it officially means*. Full detail, including exactly what's been confirmed live vs. only claimed in a document vs. still genuinely unknown, is in [07-easygas-integration.md](07-easygas-integration.md) — read that file's confidence key before trusting any specific claim about the integration.

## 5. Overall Architecture

The backend is a **layered monolith**: `routes → controllers → services → repositories → MySQL`, applied consistently in the domains that matter most (warranty, inventory, points, EasyGas sync) and inconsistently elsewhere (`userController.js` bypasses the pattern entirely — see [04-backend.md](04-backend.md) and [12-architecture-review.md](12-architecture-review.md)).

**Frontend and backend are fully separate applications**: a static Vite build served by Nginx, and an independent Express process behind the same Nginx as a reverse proxy, talking only over HTTP.

## 6. Deployment Model

Nginx (TLS + static serving + reverse proxy) in front of Express under PM2 cluster mode, backed by MySQL 8. Full detail in [08-deployment.md](08-deployment.md).

---

## Executive Summary

EZONE is a warranty-management system for a network of installer branches converting vehicles to LPG/CNG under the STAG brand, integrated with an external partner platform (EasyGas/STAG) that mints official warranty numbers and supplies the equipment/vehicle catalog. Two applications, one shared HTTP contract, each with its own git repository.

Submitting a warranty is one atomic transaction: vehicle/owner data saved, each equipment slot's barcode claimed from real physical inventory (never twice), reward points credited automatically if configured. As of this session, the cylinder is the one slot that can be free-typed instead of picked from a catalog, because EasyGas's own catalog only has two CNG cylinder models — nowhere near enough for what installers actually fit. The warranty is never pushed to EasyGas synchronously; a background sweep does that on its own schedule, retrying indefinitely, so a partner-API hiccup can never take down a warranty submission.

This session's work substantially deepened and, in a few real places, corrected the EasyGas integration: the catalog pull is now signed (previously public/unsigned), a real pagination bug that silently truncated every catalog sync to page 1 is fixed, catalog deletions are now detected and reflected locally, the two background sweeps both now have cross-worker coordination (previously only one did), and the warranty-push payload shape — long flagged as "an inferred guess" — is now confirmed against the live API, including one real correction mid-session where an earlier conclusion (drawn from a document, not a test) turned out backwards until a controlled live experiment settled it. A live, unauthenticated PII leak (a customer phone-lookup endpoint) was also found and removed entirely this session, not merely patched.

**What a new engineer should know going in:** read `services/warrantyService.js` and `services/easyGasSyncService.js` first — together they show both the intended architectural pattern and this project's most important recent lesson, demonstrated directly this session: when a partner's own documentation and your own live testing disagree, trust the live test, and build a way to re-run that test rather than trusting the document again next time. The two most consequential things not yet done are documented prominently, not buried: the frontend has no way to actually use the new typed-cylinder capability, and there is still no automated test suite anywhere in either repository. See [10-current-state.md](10-current-state.md) and [12-architecture-review.md](12-architecture-review.md).
