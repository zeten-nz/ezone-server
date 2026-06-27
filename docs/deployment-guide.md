# EZONE — Server Deployment Guide

This guide covers a complete first-time deployment to a fresh Ubuntu 22.04 LTS VPS.

---

## Prerequisites

| Requirement | Details |
|-------------|---------|
| VPS | Ubuntu 22.04 LTS, minimum 1 GB RAM, 1 vCPU |
| Domain | An A record pointing to your VPS IP (DNS propagated) |
| SSH access | Root or sudo user |
| Git repo | Project pushed to GitHub/GitLab |

---

## 1. Connect to Your VPS

```bash
ssh root@YOUR_SERVER_IP
```

---

## 2. Run the Automated Deployment Script

The quickest path is to use `deployment.sh`. Clone the repo first, then run:

```bash
# Clone the project
git clone https://github.com/YOUR_USERNAME/ezone.git /var/www/ezone
cd /var/www/ezone/ezone-server

# Make executable and run
chmod +x deployment.sh
sudo ./deployment.sh
```

The script will prompt for the MySQL application user password and handle everything else automatically.

**What the script does:**

1. Updates system packages
2. Installs Node.js 20 LTS via NodeSource
3. Installs PM2 globally
4. Installs MySQL Server
5. Installs Nginx + Certbot
6. Configures UFW firewall (ports 22, 80, 443)
7. Creates a dedicated Linux user `ezone`
8. Creates MySQL database and restricted user
9. Generates `.env` with a secure JWT secret
10. Installs npm dependencies
11. Builds the React frontend
12. Configures Nginx as reverse proxy
13. Obtains a Let's Encrypt TLS certificate
14. Starts the app with PM2 in cluster mode
15. Configures PM2 to auto-start on reboot

---

## 3. Manual Step-by-Step (if you don't use the script)

### 3.1 Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
node --version   # Should print v20.x.x
```

### 3.2 Install PM2

```bash
sudo npm install -g pm2
```

### 3.3 Install MySQL

```bash
sudo apt-get install -y mysql-server
sudo systemctl enable mysql
sudo mysql_secure_installation   # Follow the prompts
```

### 3.4 Create Database and Restricted User

```sql
-- Log in as root
sudo mysql

CREATE DATABASE ezone CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'ezone_user'@'localhost' IDENTIFIED BY 'STRONG_PASSWORD_HERE';

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX
    ON ezone.* TO 'ezone_user'@'localhost';

FLUSH PRIVILEGES;
EXIT;
```

### 3.5 Configure Environment Variables

```bash
cd /var/www/ezone/ezone-server
cp .env.example .env
nano .env
```

Fill in:
- `DB_PASSWORD` — the password you set above
- `JWT_SECRET` — generate with: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
- `ALLOWED_ORIGINS` — your frontend URL (`https://yourdomain.com`)

Secure the file:
```bash
chmod 600 .env
```

### 3.6 Install Dependencies

```bash
npm install --production
```

### 3.7 Create the Admin User

```bash
node create-admin.js "Admin Full Name" admin_username secure_password
```

### 3.8 Start with PM2

```bash
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup   # Follow the printed command to enable autostart
```

### 3.9 Install and Configure Nginx

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx

# Copy and enable the Nginx config
sudo sed 's/yourdomain.com/YOUR_DOMAIN/g' nginx.conf \
    > /etc/nginx/sites-available/ezone
sudo ln -s /etc/nginx/sites-available/ezone /etc/nginx/sites-enabled/ezone
sudo rm -f /etc/nginx/sites-enabled/default

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

### 3.10 Obtain TLS Certificate

```bash
sudo certbot --nginx -d yourdomain.com --email admin@yourdomain.com --agree-tos
```

Certbot will automatically update `nginx.conf` with the certificate paths.

---

## 4. Verify the Deployment

```bash
# API health check
curl https://yourdomain.com/health

# PM2 process status
pm2 status

# Live logs
pm2 logs ezone-api

# Nginx status
sudo systemctl status nginx
```

Expected health response:
```json
{
  "status": "ok",
  "uptime": 42.5,
  "timestamp": "2024-01-15T10:30:00.000Z",
  "environment": "production"
}
```

---

## 5. Create the First Admin Account

```bash
cd /var/www/ezone/ezone-server
node create-admin.js "Administrator" admin admin_password_here
```

---

## 6. Firewall Summary

| Port | Service | Allowed from |
|------|---------|-------------|
| 22 | SSH | Your IP only (recommended) |
| 80 | HTTP (redirect) | Everywhere |
| 443 | HTTPS | Everywhere |
| 5000 | Node.js API | 127.0.0.1 only (Nginx proxies) |
| 3306 | MySQL | 127.0.0.1 only |

To restrict SSH to your IP only:
```bash
sudo ufw delete allow 22/tcp
sudo ufw allow from YOUR_IP to any port 22
```
