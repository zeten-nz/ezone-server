# EZONE Warranty Management System — Production API

A production-ready Node.js/Express REST API for managing vehicle gas equipment warranty forms.

---

## Production Features

| Feature | Implementation |
|---------|---------------|
| Security headers | `helmet` — sets X-Frame-Options, CSP, HSTS, XSS-Protection, and more |
| CORS | Restricted to `ALLOWED_ORIGINS` from `.env` |
| Rate limiting | 100 req/15 min global · 10 req/15 min on login |
| Request logging | `morgan` — combined format in production |
| Response compression | `gzip` via `compression` middleware |
| Centralized error handling | `middleware/errorHandler.js` — no stack traces in production |
| Env validation | Fails fast on startup if required vars are missing |
| Graceful shutdown | SIGTERM/SIGINT handler — in-flight requests finish cleanly |
| Health check | `GET /health` — used by monitors and load balancers |
| Process management | PM2 cluster mode — one worker per CPU core |
| Database | MySQL connection pool — configurable size, keepalive, UTC timezone |

---

## Quick Start (Development)

```bash
git clone https://github.com/YOUR_USERNAME/ezone.git
cd ezone/ezone-server
cp .env.example .env
# Edit .env with your local MySQL credentials
npm install
npm run dev
```

API available at: `http://localhost:5000`
Health check: `http://localhost:5000/health`

---

## API Endpoints

### Authentication
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | — | Login, returns JWT |
| GET | `/api/auth/profile` | User | Get own profile |
| POST | `/api/auth/change-password` | User | Change own password |

### Users (ADMIN only)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users` | List all users |
| POST | `/api/users` | Create employee |
| GET | `/api/users/:userId` | Get user details |
| PUT | `/api/users/:userId` | Update user |
| PATCH | `/api/users/:userId/disable` | Disable user |
| POST | `/api/users/:userId/reset-password` | Reset password |

### Warranty Forms
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/warranty` | User | Submit form |
| GET | `/api/warranty` | ADMIN | List all forms |
| GET | `/api/warranty/search` | ADMIN | Search forms |
| GET | `/api/warranty/:formId` | ADMIN | Form details |
| DELETE | `/api/warranty/:formId` | ADMIN | Delete form |

### Dashboard & Export
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/dashboard` | ADMIN | Stats + recent forms |
| GET | `/api/export/warranty` | ADMIN | Export all to Excel |
| GET | `/api/export/branch` | ADMIN | Export by branch |
| GET | `/api/export/employee` | User | Export own forms |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth) |

---

## Environment Variables

See `.env.example` for the full list with descriptions.

**Required:**
- `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `JWT_SECRET` (generate: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`)

**Production-specific:**
- `NODE_ENV=production`
- `ALLOWED_ORIGINS=https://yourdomain.com`
- `LOAD_MOCK_DATA=false`

---

## Project Structure

```
ezone-server/
├── config/
│   ├── database.js        # MySQL pool configuration
│   └── mockData.js        # Development seed data
├── controllers/
│   ├── authController.js  # Login, profile, change-password
│   ├── excelController.js # Excel export logic
│   ├── userController.js  # User CRUD
│   └── warrantyController.js # Warranty form CRUD
├── middleware/
│   ├── auth.js            # JWT verification + role check
│   ├── errorHandler.js    # Centralized error + 404 handler
│   └── validateEnv.js     # Startup env validation
├── routes/
│   ├── authRoutes.js
│   ├── userRoutes.js
│   └── warrantyRoutes.js
├── docs/
│   ├── deployment-guide.md
│   ├── update-guide.md
│   ├── backup-guide.md
│   └── deployment-checklist.md
├── logs/                  # PM2 log output (git-ignored)
├── server.js              # Application entry point
├── ecosystem.config.js    # PM2 configuration
├── nginx.conf             # Nginx reverse proxy config
├── deployment.sh          # First-time server setup
├── update.sh              # Zero-downtime update script
├── backup.sh              # Database backup script
├── create-admin.js        # Admin user creation utility
└── .env.example           # Environment variable template
```

---

## PM2 Commands

```bash
# Start in production
pm2 start ecosystem.config.js --env production

# Zero-downtime reload (after code update)
pm2 reload ecosystem.config.js --env production

# Status
pm2 status

# Live logs
pm2 logs ezone-api

# Real-time dashboard
pm2 monit

# Stop
pm2 stop ezone-api
```

---

## Deployment

See the docs folder for detailed guides:

- [First-time deployment](docs/deployment-guide.md)
- [Updating the server](docs/update-guide.md)
- [Database backup & restore](docs/backup-guide.md)
- [Complete deployment checklist](docs/deployment-checklist.md)

**Automated first-time deployment:**
```bash
chmod +x deployment.sh
sudo ./deployment.sh
```

---

## Utility Scripts

```bash
# Create an admin user
node create-admin.js "Full Name" username password

# Reset database (development only — deletes all data)
node reset-database.js
```

---

## Tech Stack

- **Runtime:** Node.js 20 LTS
- **Framework:** Express.js 4
- **Database:** MySQL 8 via `mysql2` connection pool
- **Authentication:** JWT (`jsonwebtoken`) + bcrypt (`bcryptjs`)
- **Validation:** `express-validator`
- **Excel export:** `exceljs`
- **Security:** `helmet`, `cors`, `express-rate-limit`
- **Logging:** `morgan`
- **Compression:** `compression`
- **Process manager:** PM2 (cluster mode)
- **Reverse proxy:** Nginx
- **TLS:** Let's Encrypt via Certbot
