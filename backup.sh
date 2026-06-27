#!/usr/bin/env bash
# ============================================================
# EZONE — DATABASE BACKUP SCRIPT
# ============================================================
# Creates a compressed, timestamped MySQL dump and (optionally)
# uploads it to an S3-compatible object store.
#
# Recommended usage — add to cron for automated daily backups:
#   crontab -e
#   0 2 * * * /var/www/ezone/ezone-server/backup.sh >> /var/log/ezone_backup.log 2>&1
#
# This runs every day at 02:00 server time and appends output to
# /var/log/ezone_backup.log so you can review the history.
# ============================================================

set -euo pipefail
IFS=$'\n\t'

# ── Configuration ─────────────────────────────────────────────
BACKUP_DIR="/var/backups/ezone"
DB_NAME="ezone"
DB_USER="ezone_user"
RETENTION_DAYS=30           # Delete local backups older than this
TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')
BACKUP_FILE="$BACKUP_DIR/ezone_db_$TIMESTAMP.sql.gz"

# ── Optional: S3 upload ───────────────────────────────────────
# Uncomment and set these to upload backups off-server automatically.
# Requires: apt-get install awscli  then  aws configure
# S3_BUCKET="s3://your-bucket/ezone-backups/"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die() { echo "[ERROR] $*" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────
# STEP 1 — Load environment variables
# ─────────────────────────────────────────────────────────────
ENV_FILE="/var/www/ezone/ezone-server/.env"
if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a
else
    die ".env file not found at $ENV_FILE"
fi

DB_PASS="${DB_PASSWORD:-}"
[ -z "$DB_PASS" ] && die "DB_PASSWORD is not set in .env"

# ─────────────────────────────────────────────────────────────
# STEP 2 — Create backup directory
# ─────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"     # Only owner can read backup files

# ─────────────────────────────────────────────────────────────
# STEP 3 — Dump and compress
# ─────────────────────────────────────────────────────────────
log "Creating backup: $BACKUP_FILE"

mysqldump \
    --host="${DB_HOST:-localhost}" \
    --port="${DB_PORT:-3306}" \
    --user="$DB_USER" \
    --password="$DB_PASS" \
    --single-transaction \    # Consistent snapshot without locking tables
    --routines \              # Include stored procedures (if any)
    --triggers \              # Include triggers (if any)
    --set-gtid-purged=OFF \   # Suppress GTID warnings on non-replica servers
    "$DB_NAME" | gzip -9 > "$BACKUP_FILE"

BACKUP_SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
log "Backup created: $BACKUP_FILE ($BACKUP_SIZE)"

# ─────────────────────────────────────────────────────────────
# STEP 4 — Optional S3 upload
# ─────────────────────────────────────────────────────────────
# if [ -n "${S3_BUCKET:-}" ]; then
#     log "Uploading to S3: $S3_BUCKET"
#     aws s3 cp "$BACKUP_FILE" "$S3_BUCKET"
#     log "Upload complete."
# fi

# ─────────────────────────────────────────────────────────────
# STEP 5 — Delete old local backups
# ─────────────────────────────────────────────────────────────
log "Removing backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "ezone_db_*.sql.gz" -mtime "+$RETENTION_DAYS" -delete
REMAINING=$(find "$BACKUP_DIR" -name "ezone_db_*.sql.gz" | wc -l)
log "Backup rotation complete. $REMAINING backup(s) retained."

log "Backup finished successfully."

# ─────────────────────────────────────────────────────────────
# RESTORE INSTRUCTIONS (for reference — do NOT run this block)
# ─────────────────────────────────────────────────────────────
# To restore from a backup file:
#
#   gunzip < /var/backups/ezone/ezone_db_YYYY-MM-DD_HH-MM-SS.sql.gz \
#     | mysql --host=localhost --user=ezone_user --password ezone
#
# WARNING: This overwrites all current data in the 'ezone' database.
# Always test restores on a staging environment first.
