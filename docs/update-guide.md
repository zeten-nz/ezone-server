# EZONE — Update Deployment Guide

This guide explains how to deploy code updates to your running production server with **zero downtime**.

---

## Quick Update (Recommended)

SSH into the server and run the automated update script:

```bash
ssh root@YOUR_SERVER_IP
cd /var/www/ezone/ezone-server
./update.sh
```

Or update from a specific branch:
```bash
./update.sh feature/my-branch
```

The script will:
1. Pull the latest code from git
2. Install any new npm dependencies
3. Rebuild the React frontend
4. Reload PM2 with zero downtime (`pm2 reload`)
5. Verify the health check endpoint

---

## Manual Update Steps

If you prefer to run each step yourself:

### Step 1 — Pull Latest Code

```bash
cd /var/www/ezone
git pull origin main
```

### Step 2 — Install New Dependencies

```bash
cd ezone-server
npm install --production
```

> Only needed if `package.json` changed. Safe to always run.

### Step 3 — Rebuild Frontend (if frontend changed)

```bash
cd /var/www/ezone/ezone
npm install
npm run build
```

### Step 4 — Zero-Downtime API Reload

```bash
cd /var/www/ezone/ezone-server
pm2 reload ecosystem.config.js --env production
```

`pm2 reload` is different from `pm2 restart`:
- **reload** — one worker at a time, existing requests complete before the worker is replaced. Users see no downtime.
- **restart** — kills all workers simultaneously. Active requests are dropped. Causes ~1–2 seconds of downtime.

Always use `pm2 reload` in production.

### Step 5 — Verify

```bash
curl https://yourdomain.com/health
pm2 status
pm2 logs ezone-api --lines 50
```

---

## Updating Environment Variables

When you change `.env` values (e.g., rotating the JWT secret):

```bash
nano /var/www/ezone/ezone-server/.env
# Make changes
pm2 reload ecosystem.config.js --env production
```

> **Important:** Rotating `JWT_SECRET` invalidates all existing user sessions. All logged-in users will be logged out.

---

## Handling Database Migrations

The application uses `CREATE TABLE IF NOT EXISTS`, which means the schema is applied automatically on startup. However, for schema changes to existing tables (adding columns, changing types), you must run migration SQL manually:

```bash
# Connect to MySQL
mysql -u ezone_user -p ezone

# Example: adding a column
ALTER TABLE warranty_forms ADD COLUMN notes TEXT NULL AFTER injector_rail_serial_number;

EXIT;
```

Then reload the application:
```bash
pm2 reload ecosystem.config.js --env production
```

---

## Rollback

If an update breaks something, roll back to the previous commit:

```bash
cd /var/www/ezone

# See recent commits
git log --oneline -10

# Roll back to a specific commit
git checkout <COMMIT_HASH>

# Reinstall dependencies for that version
cd ezone-server && npm install --production

# Reload PM2
pm2 reload ecosystem.config.js --env production
```

---

## Checking Update History

```bash
# Git log
cd /var/www/ezone
git log --oneline -20

# PM2 restart history
pm2 describe ezone-api | grep -E "restart|uptime"

# Application logs around the update time
pm2 logs ezone-api --lines 100
```

---

## Nginx Configuration Updates

If `nginx.conf` changed:

```bash
sudo cp /var/www/ezone/ezone-server/nginx.conf /etc/nginx/sites-available/ezone
# Update yourdomain.com placeholder
sudo sed -i 's/yourdomain.com/YOUR_DOMAIN/g' /etc/nginx/sites-available/ezone
sudo nginx -t            # Always test before reloading
sudo systemctl reload nginx
```
