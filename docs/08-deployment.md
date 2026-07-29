# 08 — Environment Variables &amp; Deployment

[← Back to index](01-project-overview.md)

## Environment Variables

### Backend (`ezone-server/.env`)

| Variable | Required? | Purpose |
|---|---|---|
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | **Required** | Database connection — process exits at boot if any is missing |
| `JWT_SECRET` | **Required** | Token signing key — process exits if missing; warns (doesn't block) if left as the placeholder value |
| `ALLOWED_ORIGINS` | **Required in production only** | CORS allowlist — process exits if empty when `NODE_ENV=production` |
| `PORT` | Optional | Defaults to 5000 |
| `NODE_ENV` | Optional | Defaults to `development` |
| `DB_PORT` | Optional | Defaults to 3306 |
| `DB_POOL_SIZE` | Optional | Defaults to 10 |
| `JWT_EXPIRE` | Optional | Defaults to `7d` |
| `LOAD_MOCK_DATA` | Optional | Defaults `false`; hard-forced off in production regardless of its value |
| `EASYGAS_WARRANTY_API_BASE_URL` | Optional | **Now the base URL for both the warranty push AND the catalog pull** — the catalog previously had its own separate `EASYGAS_CATALOG_API_BASE_URL`, which is retired this session; do not reintroduce it |
| `EASYGAS_SHARED_SECRET` | Optional | HMAC signing secret, used by both the warranty push and the catalog pull |
| `EASYGAS_SYNC_INTERVAL_MS` | Optional | Warranty retry sweep interval, default 30000 |
| `EASYGAS_CATALOG_SYNC_INTERVAL_MS` | Optional | Catalog sync sweep interval, default 300000 — note this sweep now always does a **full** catalog walk every cycle, not an incremental one (see [07-easygas-integration.md](07-easygas-integration.md)) |

All four `EASYGAS_*` variables are safe to leave unset before go-live — sync just accumulates `PENDING`/retries indefinitely until real credentials arrive. **A real secret has been configured and used against the live EasyGas API this session** (via `npm run easygas:test-connection`, a manual one-off connectivity script kept permanently at the repo root — never invoked by the app itself).

### Frontend (`ezone/.env`)

| Variable | Required? | Purpose |
|---|---|---|
| `VITE_API_URL` | Not validated at runtime | The backend API base URL |

`.env.production`/`.env.example` both point at `https://api.easygas-garant.uz/api`. No runtime validation/fail-fast if unset.

## Deployment

React app built with `vite build`, served by **Nginx**. Express runs under **PM2 cluster mode** (`instances: 'max'`), 500MB memory-restart cap, 10-restart crash-loop breaker, 12s kill timeout. Nginx reverse-proxies `/api/*` and `/health`.

**SSL** via Let's Encrypt/Certbot, TLS 1.2/1.3 only.

### Deploy path

Either `deployment.sh` (full first-time VPS setup) or the manual sequence in `docs/deployment-guide.md`. Zero-downtime updates use `update.sh` with `pm2 reload`. `backup.sh` (daily, 02:00, 30-day retention) plus `docs/backup-guide.md` cover MySQL dump/restore.

> **Confirmed still broken, unchanged this session.** `package.json`'s `create-admin` script and `docs/deployment-guide.md` both document running `node create-admin.js` to bootstrap the first admin account. **This file does not exist.** There is currently no working, documented way to create the first production admin account — `LOAD_MOCK_DATA` is hard-disabled in production regardless of its value. Until fixed, the first admin must be created with a direct SQL statement (matching `bcryptjs`'s hashing scheme), or the script needs restoring/the docs need reconciling.

### New this session: `test-easygas-connection.js`

A permanent, manually-invoked (`npm run easygas:test-connection`) root-level script, matching `reset-database.js`'s existing convention. Fires one real signed request through the production EasyGas client with an obviously-synthetic payload — never real customer data — to verify the secret/signature/connectivity and inspect a real response shape. Not part of the app's own startup or request path.
