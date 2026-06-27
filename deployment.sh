#!/usr/bin/env bash
# ============================================================
# EZONE — FIRST-TIME SERVER DEPLOYMENT SCRIPT
# ============================================================
# Run this script ONCE on a fresh Ubuntu 22.04 VPS to:
#   1. Install Node.js, PM2, MySQL, Nginx
#   2. Create a restricted MySQL user
#   3. Configure the application
#   4. Set up Nginx and obtain a TLS certificate
#   5. Start the application with PM2
#
# Usage:
#   chmod +x deployment.sh
#   sudo ./deployment.sh
#
# Prerequisites:
#   • Ubuntu 22.04 LTS
#   • A domain name pointing to this server's IP
#   • Git repository cloned to /var/www/ezone
# ============================================================

set -euo pipefail   # Exit on error, undefined variable, or pipeline failure
IFS=$'\n\t'         # Safer word-splitting

# ── Configurable variables ────────────────────────────────────
DOMAIN="yourdomain.com"
APP_DIR="/var/www/ezone"
API_DIR="$APP_DIR/ezone-server"
FRONTEND_DIR="$APP_DIR/ezone"
DB_NAME="ezone"
DB_USER="ezone_user"
APP_USER="ezone"    # Non-root Linux user that will own the process
NODE_VERSION="20"   # Node.js LTS major version

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die()  { echo "[ERROR] $*" >&2; exit 1; }

# ── Root check ────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run this script with sudo: sudo ./deployment.sh"

log "Starting EZONE deployment on $DOMAIN"

# ─────────────────────────────────────────────────────────────
# STEP 1 — System update
# ─────────────────────────────────────────────────────────────
log "STEP 1: Updating system packages..."
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git ufw unzip build-essential

# ─────────────────────────────────────────────────────────────
# STEP 2 — Node.js via NodeSource
# ─────────────────────────────────────────────────────────────
log "STEP 2: Installing Node.js $NODE_VERSION LTS..."
if ! command -v node &>/dev/null; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
    apt-get install -y nodejs
fi
node --version
npm --version

# ─────────────────────────────────────────────────────────────
# STEP 3 — PM2 (process manager)
# ─────────────────────────────────────────────────────────────
log "STEP 3: Installing PM2..."
npm install -g pm2
pm2 --version

# ─────────────────────────────────────────────────────────────
# STEP 4 — MySQL Server
# ─────────────────────────────────────────────────────────────
log "STEP 4: Installing MySQL..."
if ! command -v mysql &>/dev/null; then
    apt-get install -y mysql-server
    systemctl enable mysql
    systemctl start mysql
fi

# ─────────────────────────────────────────────────────────────
# STEP 5 — Nginx
# ─────────────────────────────────────────────────────────────
log "STEP 5: Installing Nginx..."
apt-get install -y nginx certbot python3-certbot-nginx
systemctl enable nginx
systemctl start nginx

# ─────────────────────────────────────────────────────────────
# STEP 6 — Firewall
# ─────────────────────────────────────────────────────────────
log "STEP 6: Configuring UFW firewall..."
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP  (for Let's Encrypt renewal)
ufw allow 443/tcp   # HTTPS
# Node.js port is NOT opened — all traffic goes through Nginx
ufw --force enable
ufw status

# ─────────────────────────────────────────────────────────────
# STEP 7 — Application user
# ─────────────────────────────────────────────────────────────
log "STEP 7: Creating application user '$APP_USER'..."
if ! id "$APP_USER" &>/dev/null; then
    useradd --system --shell /bin/bash --create-home "$APP_USER"
fi

# ─────────────────────────────────────────────────────────────
# STEP 8 — Application directory
# ─────────────────────────────────────────────────────────────
log "STEP 8: Setting up application directory..."
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# If the repo isn't cloned yet, clone it (replace URL with your repo)
if [ ! -d "$API_DIR" ]; then
    log "Cloning repository..."
    sudo -u "$APP_USER" git clone https://github.com/YOUR_USERNAME/ezone.git "$APP_DIR"
fi

# ─────────────────────────────────────────────────────────────
# STEP 9 — MySQL database and restricted user
# ─────────────────────────────────────────────────────────────
log "STEP 9: Creating MySQL database and user..."
echo "Enter a STRONG password for the MySQL application user ($DB_USER):"
read -rs DB_PASS
echo

mysql -u root <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\`
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

-- Create a dedicated user with only the permissions this app needs.
-- NEVER use the root MySQL user for the application.
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';

-- Grant only what is necessary (principle of least privilege)
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX
    ON \`$DB_NAME\`.*
    TO '$DB_USER'@'localhost';

FLUSH PRIVILEGES;
SQL

log "Database '$DB_NAME' and user '$DB_USER' created."

# ─────────────────────────────────────────────────────────────
# STEP 10 — Environment file
# ─────────────────────────────────────────────────────────────
log "STEP 10: Creating .env file..."
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")

cat > "$API_DIR/.env" <<EOF
PORT=5000
NODE_ENV=production

DB_HOST=localhost
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS
DB_NAME=$DB_NAME
DB_PORT=3306
DB_POOL_SIZE=10

JWT_SECRET=$JWT_SECRET
JWT_EXPIRE=7d

ALLOWED_ORIGINS=https://$DOMAIN
LOAD_MOCK_DATA=false
EOF

chmod 600 "$API_DIR/.env"   # Only the owner can read it
chown "$APP_USER:$APP_USER" "$API_DIR/.env"
log ".env created with a generated JWT_SECRET."

# ─────────────────────────────────────────────────────────────
# STEP 11 — Install Node.js dependencies
# ─────────────────────────────────────────────────────────────
log "STEP 11: Installing npm dependencies..."
cd "$API_DIR"
sudo -u "$APP_USER" npm install --production

# Create logs directory
mkdir -p "$API_DIR/logs"
chown "$APP_USER:$APP_USER" "$API_DIR/logs"

# ─────────────────────────────────────────────────────────────
# STEP 12 — Build React frontend
# ─────────────────────────────────────────────────────────────
log "STEP 12: Building React frontend..."
if [ -d "$FRONTEND_DIR" ]; then
    cd "$FRONTEND_DIR"
    sudo -u "$APP_USER" npm install
    sudo -u "$APP_USER" npm run build
    log "Frontend built at $FRONTEND_DIR/dist"
else
    log "WARNING: Frontend directory not found at $FRONTEND_DIR — skipping build."
fi

# ─────────────────────────────────────────────────────────────
# STEP 13 — Nginx configuration
# ─────────────────────────────────────────────────────────────
log "STEP 13: Configuring Nginx..."

# Replace placeholder domain name in the nginx config
sed "s/yourdomain.com/$DOMAIN/g" "$API_DIR/nginx.conf" > /etc/nginx/sites-available/ezone

# Enable the site
ln -sf /etc/nginx/sites-available/ezone /etc/nginx/sites-enabled/ezone

# Disable the default site
rm -f /etc/nginx/sites-enabled/default

nginx -t || die "Nginx configuration test failed"
systemctl reload nginx

# ─────────────────────────────────────────────────────────────
# STEP 14 — TLS certificate via Let's Encrypt
# ─────────────────────────────────────────────────────────────
log "STEP 14: Obtaining TLS certificate from Let's Encrypt..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN"

# ─────────────────────────────────────────────────────────────
# STEP 15 — Start application with PM2
# ─────────────────────────────────────────────────────────────
log "STEP 15: Starting application with PM2..."
cd "$API_DIR"
sudo -u "$APP_USER" pm2 start ecosystem.config.js --env production
sudo -u "$APP_USER" pm2 save

# Configure PM2 to start on system boot
pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER"

# ─────────────────────────────────────────────────────────────
# STEP 16 — Create admin user
# ─────────────────────────────────────────────────────────────
log "STEP 16: Creating initial admin user..."
log "Run the following command to create an admin account:"
echo ""
echo "  cd $API_DIR && node create-admin.js \"Admin Name\" admin_username password123"
echo ""

# ─────────────────────────────────────────────────────────────
# COMPLETE
# ─────────────────────────────────────────────────────────────
log "=============================================="
log "  Deployment complete!"
log "  API:     https://$DOMAIN/api/health"
log "  Frontend: https://$DOMAIN"
log "  PM2 logs: pm2 logs ezone-api"
log "=============================================="
