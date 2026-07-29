#!/usr/bin/env bash
# ============================================================
# EZONE — ZERO-DOWNTIME UPDATE SCRIPT
# ============================================================
# Run this script on the server whenever you deploy new code.
# It pulls the latest changes, rebuilds, and reloads PM2 with
# zero downtime (existing requests finish before old workers exit).
#
# Usage:
#   chmod +x update.sh
#   ./update.sh [branch]
#
# Default branch: main
# ============================================================

set -euo pipefail
IFS=$'\n\t'

BRANCH="${1:-main}"
APP_DIR="/var/www/ezone"
API_DIR="$APP_DIR/ezone-server"
FRONTEND_DIR="$APP_DIR/ezone"
APP_USER="ezone"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die() { echo "[ERROR] $*" >&2; exit 1; }

log "Starting update from branch '$BRANCH'..."

# ─────────────────────────────────────────────────────────────
# STEP 1 — Pull latest code
# ─────────────────────────────────────────────────────────────
log "STEP 1: Pulling latest code..."
cd "$APP_DIR"
sudo -u "$APP_USER" git fetch origin
sudo -u "$APP_USER" git checkout "$BRANCH"
sudo -u "$APP_USER" git pull origin "$BRANCH"

# ─────────────────────────────────────────────────────────────
# STEP 2 — Install / update backend dependencies
# ─────────────────────────────────────────────────────────────
log "STEP 2: Installing backend dependencies..."
cd "$API_DIR"
sudo -u "$APP_USER" npm install --production

# ─────────────────────────────────────────────────────────────
# STEP 3 — Build React frontend
# ─────────────────────────────────────────────────────────────
log "STEP 3: Building React frontend..."
if [ -d "$FRONTEND_DIR" ]; then
    cd "$FRONTEND_DIR"
    sudo -u "$APP_USER" npm install
    sudo -u "$APP_USER" npm run build
    log "Frontend rebuilt."
fi

# ─────────────────────────────────────────────────────────────
# STEP 4 — Reload API with zero downtime
# ─────────────────────────────────────────────────────────────
# pm2 reload sends SIGINT to one worker at a time, waits for it to finish
# current requests, starts a new worker, then moves to the next.
# Traffic never drops — users experience no downtime.
log "STEP 4: Reloading API with zero downtime..."
cd "$API_DIR"
sudo -u "$APP_USER" pm2 reload ecosystem.config.js --env production

# ─────────────────────────────────────────────────────────────
# STEP 5 — Verify
# ─────────────────────────────────────────────────────────────
log "STEP 5: Verifying health check..."
sleep 3  # Give PM2 a moment to finish the reload cycle

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5000/health || echo "000")
if [ "$HTTP_STATUS" = "200" ]; then
    log "Health check passed (HTTP $HTTP_STATUS)."
else
    die "Health check FAILED (HTTP $HTTP_STATUS). Check: pm2 logs ezone-api"
fi

log "Update complete. Current PM2 status:"
sudo -u "$APP_USER" pm2 status



   RAIL IG7 Dakota 4 sil.  Mavjud test 7/21/2026     KME NEVO-SKY Direct 4 Model 2  Mavjud test 7/21/2026     STAKO 50L  Mavjud test 7/21/2026     ADAX AR01