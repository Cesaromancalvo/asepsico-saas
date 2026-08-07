#!/usr/bin/env sh
set -eu
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL es obligatorio y debe apuntar a una base aislada}"
FILE="${1:?Uso: restore-check.sh archivo.dump}"
sha256sum -c "$FILE.sha256"
pg_restore --clean --if-exists --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL" "$FILE"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT COUNT(*) AS workspaces FROM "Workspace";'
printf '%s\n' 'Restauración de prueba completada.'
