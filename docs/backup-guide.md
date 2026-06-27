# EZONE — Backup Guide

---

## Overview

| What | Where | How often |
|------|-------|----------|
| MySQL database | `/var/backups/ezone/` | Daily (automated) |
| `.env` file | Secure password manager | After each change |
| Application code | Git repository | Every commit |
| Nginx config | `/etc/nginx/sites-available/ezone` | After each change |
| Let's Encrypt certs | `/etc/letsencrypt/` | Auto-renewed by Certbot |

---

## Automated Daily Database Backups

### Set Up the Cron Job

```bash
# Open the crontab editor
crontab -e

# Add this line to run the backup every day at 02:00 AM server time
0 2 * * * /var/www/ezone/ezone-server/backup.sh >> /var/log/ezone_backup.log 2>&1
```

### What the Script Does

1. Loads credentials from `.env`
2. Runs `mysqldump --single-transaction` (no table locks during backup)
3. Compresses the dump with `gzip -9`
4. Saves to `/var/backups/ezone/ezone_db_YYYY-MM-DD_HH-MM-SS.sql.gz`
5. Deletes backups older than 30 days

### Make It Executable

```bash
chmod +x /var/www/ezone/ezone-server/backup.sh
```

### Test It Manually

```bash
/var/www/ezone/ezone-server/backup.sh
ls -lh /var/backups/ezone/
```

---

## Manual Backup

Run at any time (before a major update, for example):

```bash
cd /var/www/ezone/ezone-server
./backup.sh
```

Or directly with mysqldump:

```bash
mysqldump \
  --user=ezone_user \
  --password \
  --single-transaction \
  ezone | gzip -9 > ~/ezone_manual_$(date '+%Y%m%d_%H%M%S').sql.gz
```

---

## Restore from Backup

> **Warning:** Restoring overwrites all current data. Always test on a staging environment first.

```bash
# List available backups
ls -lh /var/backups/ezone/

# Restore a specific backup file
gunzip < /var/backups/ezone/ezone_db_YYYY-MM-DD_HH-MM-SS.sql.gz \
  | mysql --user=ezone_user --password ezone

# Confirm tables are intact
mysql -u ezone_user -p -e "SELECT COUNT(*) FROM ezone.users; SELECT COUNT(*) FROM ezone.warranty_forms;"
```

After restoring, reload the application:
```bash
pm2 reload ecosystem.config.js --env production
```

---

## Off-Server Backup (Recommended for Production)

Local backups disappear if the VPS disk fails. Upload to an off-server location.

### Option A: AWS S3

```bash
# Install AWS CLI
sudo apt-get install -y awscli
aws configure   # Enter your IAM key, secret, and region

# Upload a backup
aws s3 cp /var/backups/ezone/ezone_db_2024-01-15.sql.gz s3://your-bucket/ezone-backups/
```

Enable automatic S3 uploads in `backup.sh` by uncommenting the S3 section:
```bash
nano /var/www/ezone/ezone-server/backup.sh
# Uncomment: S3_BUCKET="s3://your-bucket/ezone-backups/"
# Uncomment: aws s3 cp "$BACKUP_FILE" "$S3_BUCKET"
```

### Option B: rsync to a second server

```bash
rsync -avz /var/backups/ezone/ user@backup-server:/backups/ezone/
```

Add this to cron after the backup job:
```bash
5 2 * * * rsync -avz /var/backups/ezone/ user@backup-server:/backups/ezone/ >> /var/log/ezone_backup.log 2>&1
```

---

## Backup the .env File

The `.env` contains your JWT secret and database password. If you lose it:
- The JWT secret cannot be recovered — all user sessions will be invalidated
- You will need the DB password to restore data

**Store .env securely outside the server:**
- 1Password / Bitwarden (recommended)
- A private note in a password manager
- A private, encrypted file in a separate secure location

```bash
# View .env to copy its contents
cat /var/www/ezone/ezone-server/.env
```

---

## Verify Backups Regularly

A backup that cannot be restored is worthless. Test restores at least monthly:

```bash
# Check backup files exist and are growing
ls -lh /var/backups/ezone/
cat /var/log/ezone_backup.log | tail -20

# Test-restore to a temporary database
mysql -u root -p -e "CREATE DATABASE ezone_test;"
gunzip < /var/backups/ezone/ezone_db_LATEST.sql.gz | mysql -u root -p ezone_test
mysql -u root -p -e "SELECT COUNT(*) FROM ezone_test.warranty_forms;"
mysql -u root -p -e "DROP DATABASE ezone_test;"
```

---

## Disk Space Monitoring

Backups accumulate. Monitor disk usage:

```bash
# Check disk usage
df -h /var/backups/

# Check backup directory size
du -sh /var/backups/ezone/

# Manually delete old backups if needed
find /var/backups/ezone/ -name "*.sql.gz" -mtime +60 -delete
```
