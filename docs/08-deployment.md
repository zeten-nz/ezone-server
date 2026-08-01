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

There are no partner-integration environment variables anymore — the third-party warranty-sync integration (and every env var it needed) has been fully and permanently removed.

### Frontend (`ezone/.env`)

| Variable | Required? | Purpose |
|---|---|---|
| `VITE_API_URL` | Not validated at runtime | The backend API base URL |

`.env.production`/`.env.example` point `VITE_API_URL` at the production API's base URL. No runtime validation/fail-fast if unset.

## Deployment

React app built with `vite build`, served by **Nginx**. Express runs under **PM2 cluster mode** (`instances: 'max'`), 500MB memory-restart cap, 10-restart crash-loop breaker, 12s kill timeout. Nginx reverse-proxies `/api/*` and `/health`.

**SSL** via Let's Encrypt/Certbot, TLS 1.2/1.3 only.

### Deploy path

Either `deployment.sh` (full first-time VPS setup) or the manual sequence in `docs/deployment-guide.md`. Zero-downtime updates use `update.sh` with `pm2 reload`. `backup.sh` (daily, 02:00, 30-day retention) plus `docs/backup-guide.md` cover MySQL dump/restore.

> **Confirmed still broken, unchanged this session.** `package.json`'s `create-admin` script and `docs/deployment-guide.md` both document running `node create-admin.js` to bootstrap the first admin account. **This file does not exist.** There is currently no working, documented way to create the first production admin account — `LOAD_MOCK_DATA` is hard-disabled in production regardless of its value. Until fixed, the first admin must be created with a direct SQL statement (matching `bcryptjs`'s hashing scheme), or the script needs restoring/the docs need reconciling.
