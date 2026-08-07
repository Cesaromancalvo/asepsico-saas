# Prueba 3B — Backup y restauración, ejecutado de verdad contra PostgreSQL real

## Qué se hizo distinto de `PRUEBA_3_BACKUP_RESTORE_REAL.md`

El documento anterior admitía que el script nunca se había ejecutado por falta de
PostgreSQL en el entorno. Esta vez se instaló PostgreSQL 16 real, se aplicaron las 14
migraciones SQL del repositorio tal cual (sin `prisma generate`, directamente con `psql`),
se insertaron filas de prueba, y se ejecutó `scripts/test-backup-restore.sh` de principio a fin.

## Bug encontrado y corregido en `scripts/test-backup-restore.sh`

El script **fallaba en el primer intento real**, con `invalid command \` en el paso 2/6.
Causa: la variable `fingerprint_sql` usaba `\` al final de cada línea dentro de comillas
simples de `sh`, asumiendo que actuaría como continuación de línea. Dentro de comillas
simples de POSIX `sh` eso NO ocurre — la barra invertida se incluye literalmente en la
cadena, y `psql` interpreta un `\` al principio de línea como un metacomando, no como SQL.

Además, el filtro `WHERE schemaname = ''public''` tampoco habría funcionado aunque se
arreglara lo anterior: `''` dentro de una cadena ya abierta con comillas simples no inserta
una comilla literal, cierra y reabre la comilla sin añadir ningún carácter. El resultado real
habría sido `WHERE schemaname = public` (sin comillas), SQL inválido.

Se corrigieron ambos problemas: se sustituyeron los saltos de línea con `\` por saltos de
línea reales (válidos dentro de comillas simples de `sh`), y las comillas simples literales
se generan con el idiom estándar `'"'"'` (cerrar comilla, insertar comilla literal vía
comillas dobles, reabrir comilla).

## Ejecución

```bash
export DATABASE_URL='postgresql://postgres:postgres@localhost:5432/asepsico_staging'
export RESTORE_DATABASE_URL='postgresql://postgres:postgres@localhost:5432/asepsico_restore_test'
sh scripts/test-backup-restore.sh
```

## Resultado

```
[1/6] Comprobando conectividad...
[2/6] Calculando huella de la base origen...
[3/6] Generando backup real...
./backups/restore-test/asepsico-restore-test-20260801T083114Z.dump: OK
[4/6] Restaurando en base aislada...
[5/6] Validando esquema y datos restaurados...
[6/6] Prueba completada correctamente.
```

- 27 tablas migradas desde el schema real del repo (14 migraciones SQL aplicadas en orden,
  sin errores).
- Huella origen y huella restaurada: **0 diferencias** (`diff` sin salida) en las 27 tablas
  y sus recuentos de filas.
- Verificación adicional a mano: la fila de paciente de prueba (`Laura Gomez`) se comprobó
  presente e íntegra en la base restaurada tras el `pg_restore`.

## Conclusión

El proceso de backup/restore ya está probado de extremo a extremo contra PostgreSQL real,
no solo validado sintácticamente. El script en el repositorio queda corregido y funcional.

Pendiente real: repetir esta prueba contra un volumen de datos representativo (no un único
paciente de prueba) y, cuando exista, contra el tamaño de base de datos esperado en
producción, para tener una medida de cuánto tarda el backup/restore a esa escala.
