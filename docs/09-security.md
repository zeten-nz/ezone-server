# 09 — Security Review

[← Back to index](01-project-overview.md)

## What's Actually Implemented

- **Helmet**, **CORS** (env-configured allowlist, fails closed in production if unset), **compression**, **Morgan** request logging.
- **Three rate limiters**: global 100/15min, dedicated 500/15min for `/api/reports`, stricter 10/15min for `/api/auth`.
- **SQL injection**: every user-supplied value goes through `?` placeholders; the only string-interpolated SQL is server-computed pagination/WHERE-clause scaffolding built from bound conditions.
- **File uploads**: server-generated filenames only, extension/mimetype pre-filter plus real post-write magic-byte verification, 5MB cap.
- **CSV export**: OWASP formula-injection mitigation, proper escaping, UTF-8 BOM, keyset pagination.
- **Secrets**: no hardcoded secrets found anywhere; `JWT_SECRET` is exclusively environment-sourced — never logged, never committed (`.env` confirmed gitignored).
- **JWT re-verification**: every request re-checks `is_active`/`role`/`is_super_admin` live against the database.

## Gaps

| Gap | Detail |
|---|---|
| No JWT revocation/blacklist | A leaked token is valid until its natural 7-day expiry regardless of logout (deactivating the account is the only immediate remedy) |
| Coarse auth rate limiting | Register and login share one 10/15min budget |
| CORS falls open for no-Origin requests | Deliberate accommodation for non-browser clients — mitigated entirely by JWT auth, not CORS |

## Resolved This Session: A Real, Live PII Leak

`POST /api/public/customer/warranties` — a phone-number-only customer warranty lookup with **zero request-level authentication** — was demonstrated live to expose real customer name, phone, VIN, plate, vehicle, mileage, and installer detail to anyone on the internet with no credentials. It has been **removed entirely** (controller, routes, the repository method that backed it, and the `server.js` mount) rather than retrofitted with authentication, since no confirmed consumer needed it. This is the single most consequential security finding and fix of this documentation period, and it's worth a new engineer understanding the history: this endpoint was originally built deliberately, for a specific external consumer, with the auth gap treated as an accepted, temporary tradeoff pending network-layer protection — that assumption turned out not to hold in practice.

## Historical Security Fix, Confirmed Resolved

`product_point_configs`/`product_point_config_history`'s foreign key to `products` was originally `ON DELETE CASCADE` — deleting a product used to silently destroy its point configuration and entire audit-history trail. A migration helper converts this to `RESTRICT` on any database still running the old definition — confirmed applied. See [03-database.md](03-database.md).
