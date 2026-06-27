# EZONE — Production Deployment Checklist

Use this checklist before going live and after every major deployment.

---

## Pre-Deployment (Local)

### Code & Configuration

- [ ] All API endpoints tested locally and returning correct responses
- [ ] No `console.log` debug statements left in controllers
- [ ] No hardcoded IP addresses, ports, or credentials in source files
- [ ] `.env` is listed in `.gitignore` (never committed)
- [ ] `.env.example` is up to date with all required variables
- [ ] `LOAD_MOCK_DATA=false` in production `.env`
- [ ] `NODE_ENV=production` in production `.env`
- [ ] `JWT_SECRET` is a cryptographically random 64-byte hex string (not the placeholder)
- [ ] `ALLOWED_ORIGINS` contains only the production frontend URL
- [ ] `package.json` engines field specifies minimum Node.js version (`>=18.0.0`)

### Security

- [ ] JWT secret generated with `crypto.randomBytes(64).toString('hex')`
- [ ] MySQL user has only `SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX` (no `GRANT` or `DROP`)
- [ ] `.env` file has `chmod 600` (owner read-only)
- [ ] No `root` MySQL user in the application `.env`

---

## Server Setup

### Operating System

- [ ] Ubuntu 22.04 LTS (or later LTS)
- [ ] All system packages updated (`apt-get update && apt-get upgrade`)
- [ ] Non-root user created for the application (`useradd --system ezone`)

### Node.js & PM2

- [ ] Node.js 20+ LTS installed (`node --version`)
- [ ] PM2 installed globally (`pm2 --version`)
- [ ] PM2 startup script configured (`pm2 startup` + `pm2 save`)
- [ ] `ecosystem.config.js` uses `exec_mode: 'cluster'` and `instances: 'max'`
- [ ] `logs/` directory exists and is writable by the app user

### Database

- [ ] MySQL Server installed and running (`systemctl status mysql`)
- [ ] Database `ezone` created with `utf8mb4` character set
- [ ] Dedicated MySQL user created (not root)
- [ ] MySQL user has correct permissions (tested by logging in)
- [ ] MySQL not exposed externally (only `localhost` connections)

### Nginx

- [ ] Nginx installed and running
- [ ] `nginx.conf` deployed to `/etc/nginx/sites-available/ezone`
- [ ] Site symlinked to `sites-enabled`
- [ ] Default Nginx site removed from `sites-enabled`
- [ ] `nginx -t` passes without errors
- [ ] `proxy_pass` points to correct Node.js port (`http://127.0.0.1:5000`)
- [ ] `client_max_body_size 10M` set (matches Node.js body limit)
- [ ] Static files served directly from Nginx (not proxied to Node)

### TLS / SSL

- [ ] Let's Encrypt certificate obtained for production domain
- [ ] HTTP → HTTPS redirect active (test: `curl -I http://yourdomain.com`)
- [ ] TLS protocols limited to TLS 1.2 and TLS 1.3 only
- [ ] HSTS header present (`Strict-Transport-Security`)
- [ ] Certificate auto-renewal tested (`sudo certbot renew --dry-run`)

### Firewall (UFW)

- [ ] Port 22 open (SSH) — ideally restricted to your IP
- [ ] Port 80 open (HTTP — needed for ACME renewal)
- [ ] Port 443 open (HTTPS)
- [ ] Port 5000 NOT open externally (only Nginx accesses it locally)
- [ ] Port 3306 NOT open externally (only localhost)
- [ ] UFW enabled (`ufw status`)

---

## Application

### Startup

- [ ] `npm install --production` run (no devDependencies in production)
- [ ] Application starts without errors (`pm2 logs ezone-api`)
- [ ] `/health` endpoint returns `{"status":"ok"}` with HTTP 200
- [ ] Database tables created automatically on first start
- [ ] Admin user created (`node create-admin.js`)

### API Functionality

- [ ] `POST /api/auth/login` — returns JWT token
- [ ] `GET /api/auth/profile` — returns user profile (with token)
- [ ] `GET /api/dashboard` — returns stats (ADMIN only)
- [ ] `GET /api/users` — returns user list (ADMIN only)
- [ ] `POST /api/warranty` — creates warranty form
- [ ] `GET /api/warranty` — lists all forms (ADMIN only)
- [ ] `GET /api/export/warranty` — downloads Excel (ADMIN only)
- [ ] `GET /health` — health check works

### Rate Limiting

- [ ] Login endpoint rejects after 10 requests in 15 minutes (test with curl)
- [ ] API returns `429` status when rate limited
- [ ] Rate limit headers present in responses (`RateLimit-*`)

### CORS

- [ ] Frontend domain is in `ALLOWED_ORIGINS`
- [ ] Browser requests from allowed origin succeed
- [ ] Browser requests from unknown origin are rejected with CORS error

---

## Monitoring & Operations

### Logging

- [ ] `pm2 logs ezone-api` shows request logs from Morgan
- [ ] Error log and output log are in separate files (`logs/error.log`, `logs/out.log`)
- [ ] `/var/log/nginx/ezone_access.log` receiving requests
- [ ] No sensitive data (passwords, JWT tokens) appearing in logs

### Backups

- [ ] `backup.sh` is executable and runs without error
- [ ] Cron job configured for daily backups at 02:00
- [ ] `/var/backups/ezone/` exists and first backup file is present
- [ ] Off-server backup destination configured (S3 or rsync)
- [ ] A test restore has been successfully performed

### Alerting (Recommended)

- [ ] Uptime monitor configured (UptimeRobot / Better Uptime / Pingdom) on `/health`
- [ ] Alert email configured for downtime
- [ ] Disk space alert configured (warn at 80% usage)

---

## Post-Deployment Verification

Run these after every deployment:

```bash
# 1. Health check
curl https://yourdomain.com/health

# 2. PM2 status (all instances online)
pm2 status

# 3. Recent logs (no errors)
pm2 logs ezone-api --lines 50

# 4. Nginx status
sudo systemctl status nginx

# 5. TLS grade (check via browser or https://www.ssllabs.com/ssltest/)
curl -I https://yourdomain.com | grep -i "strict-transport"

# 6. Rate limiting (should get 429 after 10 rapid login attempts)
for i in {1..12}; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST https://yourdomain.com/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"test","password":"test"}'
done
```

---

## Emergency Contacts

| Situation | Command |
|-----------|---------|
| App crashed | `pm2 restart ezone-api` |
| High memory | `pm2 reload ecosystem.config.js --env production` |
| View live logs | `pm2 logs ezone-api` |
| Nginx issue | `sudo systemctl status nginx` / `sudo nginx -t` |
| DB connection fail | `systemctl status mysql` |
| Roll back code | `git checkout <previous_commit> && pm2 reload ...` |
| Restore DB | See `docs/backup-guide.md` |
