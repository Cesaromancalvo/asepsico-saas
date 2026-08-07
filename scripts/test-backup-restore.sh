#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL es obligatorio y debe apuntar a la base origen de staging}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL es obligatorio y debe apuntar a una base aislada y vacia}"

BACKUP_DIR="${BACKUP_DIR:-./backups/restore-test}"
mkdir -p "$BACKUP_DIR"

for cmd in pg_dump pg_restore psql sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "ERROR: falta la herramienta requerida: $cmd" >&2
    exit 127
  }
done

if [ "$DATABASE_URL" = "$RESTORE_DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL y RESTORE_DATABASE_URL no pueden ser iguales." >&2
  exit 2
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP_FILE="$BACKUP_DIR/asepsico-restore-test-$STAMP.dump"
SOURCE_FINGERPRINT="$BACKUP_DIR/source-$STAMP.tsv"
RESTORED_FINGERPRINT="$BACKUP_DIR/restored-$STAMP.tsv"

fingerprint_sql='
WITH tables AS (
  SELECT schemaname, tablename
  FROM pg_tables
  WHERE schemaname = '"'"'public'"'"'
)
SELECT schemaname || '"'"'.'"'"' || tablename AS table_name,
       (xpath('"'"'/row/count/text()'"'"', query_to_xml(format('"'"'SELECT count(*) AS count FROM %I.%I'"'"', schemaname, tablename), false, true, '"'"''"'"')))[1]::text::bigint AS row_count
FROM tables
ORDER BY table_name;'

echo "[1/6] Comprobando conectividad..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc 'SELECT current_database();' >/dev/null
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc 'SELECT current_database();' >/dev/null

echo "[2/6] Calculando huella de la base origen..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -F '\t' -Atqc "$fingerprint_sql" > "$SOURCE_FINGERPRINT"

echo "[3/6] Generando backup real..."
pg_dump --format=custom --no-owner --no-acl --file="$DUMP_FILE" "$DATABASE_URL"
sha256sum "$DUMP_FILE" > "$DUMP_FILE.sha256"
sha256sum -c "$DUMP_FILE.sha256"

echo "[4/6] Restaurando en base aislada..."
pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error --dbname="$RESTORE_DATABASE_URL" "$DUMP_FILE"

echo "[5/6] Validando esquema y datos restaurados..."
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -F '\t' -Atqc "$fingerprint_sql" > "$RESTORED_FINGERPRINT"

if ! diff -u "$SOURCE_FINGERPRINT" "$RESTORED_FINGERPRINT"; then
  echo "ERROR: la huella de tablas/recuentos no coincide tras la restauracion." >&2
  exit 3
fi

psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc 'SELECT COUNT(*) FROM "Workspace";' >/dev/null

echo "[6/6] Prueba completada correctamente."
echo "Backup: $DUMP_FILE"
echo "Huella origen: $SOURCE_FINGERPRINT"
echo "Huella restaurada: $RESTORED_FINGERPRINT"
