#!/usr/bin/env sh
set -eu
: "${DATABASE_URL:?DATABASE_URL es obligatorio}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$BACKUP_DIR/asepsico-$STAMP.dump"
pg_dump --format=custom --no-owner --no-acl --file="$FILE" "$DATABASE_URL"
sha256sum "$FILE" > "$FILE.sha256"
find "$BACKUP_DIR" -type f -mtime "+$RETENTION_DAYS" -delete
printf '%s\n' "$FILE"
