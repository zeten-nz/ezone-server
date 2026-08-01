# EZONE Warranty ERP — Project Documentation

This documentation reflects the current codebase — both `ezone-server` (backend) and `ezone` (frontend), two separate git repositories under one non-repo parent folder — after the previously-integrated third-party warranty-sync platform was fully and permanently removed. Every claim traces to an actual file in the current codebase. Where a previous documentation pass described that removed integration, that content has been removed or rewritten rather than left as a stale reference.

## Documentation Index

| File | Covers |
|---|---|
| [01-project-overview.md](01-project-overview.md) | This file — what the system is, who uses it, overall architecture |
| [02-architecture.md](02-architecture.md) | Technology stack, folder structure |
| [03-database.md](03-database.md) | Every table, relationship, index, migration — Live/Legacy/Dormant/Dead status per column |
| [04-backend.md](04-backend.md) | Auth, backend layering, warranty/inventory/points/reporting systems |
| [05-frontend.md](05-frontend.md) | React app structure, and where it hasn't caught up with the backend |
| [06-api.md](06-api.md) | Complete HTTP endpoint reference |
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

## 2. Who Uses It

Two roles (`users.role ENUM('ADMIN','EMPLOYEE')`), plus an additive **Super Admin** flag on top of `ADMIN`:

- **EMPLOYEE** — installer/branch technician. Submits warranty forms, views own history/points/statistics.
- **ADMIN** — manages users, branches, product catalog, inventory, reviews reports.
- **Super Admin** — the tier reserved for the two actions with the most blast radius: configuring per-product point values, and correcting inventory records by hand.

New employees don't land directly in `users` — they submit a `registration_requests` row that an admin must explicitly approve.

## 3. Major Workflows

**Warranty creation**: an EMPLOYEE submits vehicle/owner data plus 4 fixed equipment slots. The cylinder slot can also be free-typed (brand + capacity) instead of picked from the catalog — see §4 below. Each real (non-typed) slot's barcode is validated against physical inventory and atomically claimed, all inside one transaction; a sequential warranty number (`W-YYYY-NNNNNN`) is assigned locally in the same transaction. A warranty is simply created once its row exists in `warranty_forms` — there is no pending state, no sync lifecycle, and no background job involved. Retrying the same submission (the same `submission_uuid`) is safe — it returns the existing form rather than creating a duplicate.

**Inventory management**: admins bulk-import physical barcoded units per product via CSV; installers consume ("claim") them at submission time; admins can manually correct, transfer, or merge records, all audited.

**Points**: installers automatically earn points per equipment slot installed, if a point value is configured for that product — never a manual "claim" action. Reversed automatically on edit/delete. A typed cylinder always earns 0 points, since there's no catalog product to configure a value against.

## 4. Overall Architecture

The backend is a **layered monolith**: `routes → controllers → services → repositories → MySQL`, applied consistently in the domains that matter most (warranty, inventory, points) and inconsistently elsewhere (`userController.js` bypasses the pattern entirely — see [04-backend.md](04-backend.md) and [12-architecture-review.md](12-architecture-review.md)).

**Frontend and backend are fully separate applications**: a static Vite build served by Nginx, and an independent Express process behind the same Nginx as a reverse proxy, talking only over HTTP.

## 5. Deployment Model

Nginx (TLS + static serving + reverse proxy) in front of Express under PM2 cluster mode, backed by MySQL 8. Full detail in [08-deployment.md](08-deployment.md).

---

## Executive Summary

EZONE is a standalone warranty-management system for a network of installer branches converting vehicles to LPG/CNG under the STAG brand. Two applications, one shared HTTP contract, each with its own git repository.

Submitting a warranty is one atomic transaction: vehicle/owner data saved, each equipment slot's barcode claimed from real physical inventory (never twice), reward points credited automatically if configured, and a sequential warranty number assigned locally. The cylinder is the one slot that can be free-typed instead of picked from a catalog, since installers fit far more cylinder variants than any fixed catalog could realistically enumerate. Brands, cars, and products are all local ERP master data, managed through full admin CRUD screens — there is no external catalog to synchronize against, and nothing is pushed to or pulled from any third-party system.

**What a new engineer should know going in:** read `services/warrantyService.js` first — it shows the intended architectural pattern (transaction boundary, atomic inventory claim, points award, local sequential warranty numbering) that the rest of the codebase should be judged against. The two most consequential things not yet done are documented prominently, not buried: the frontend has no way to actually use the typed-cylinder capability, and there is still no automated test suite anywhere in either repository. See [10-current-state.md](10-current-state.md) and [12-architecture-review.md](12-architecture-review.md).
