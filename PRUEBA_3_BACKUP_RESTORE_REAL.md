# Prueba 3 — Backup y restauración real

## Objetivo

Comprobar que un backup generado con `pg_dump` puede restaurarse íntegramente en una base PostgreSQL aislada y que el contenido restaurado coincide con la base origen.

## Automatización añadida

Se ha incorporado:

```text
scripts/test-backup-restore.sh
```

La prueba realiza:

1. Verificación de herramientas PostgreSQL.
2. Comprobación de conectividad con origen y destino.
3. Huella de todas las tablas públicas y su número de filas.
4. Backup real en formato custom.
5. Verificación SHA-256 del archivo.
6. Restauración real con `pg_restore --exit-on-error`.
7. Nueva huella de la base restaurada.
8. Comparación exacta de tablas y recuentos.
9. Consulta de control sobre la tabla `Workspace`.

## Medidas de seguridad

- Exige dos URL diferentes.
- Rechaza origen y destino idénticos.
- La base de restauración debe ser aislada.
- No crea ni elimina bases de datos.
- No debe apuntarse nunca a producción como destino.

## Ejecución

```bash
export DATABASE_URL='postgresql://usuario:clave@localhost:5432/asepsico_staging'
export RESTORE_DATABASE_URL='postgresql://usuario:clave@localhost:5432/asepsico_restore_test'
./scripts/test-backup-restore.sh
```

## Resultado en este entorno

No se ha podido ejecutar una restauración real porque el entorno no dispone de Docker, PostgreSQL, `psql`, `pg_dump` ni `pg_restore`. También está bloqueada la descarga de paquetes del sistema.

Por tanto, la automatización está integrada y validada sintácticamente, pero la restauración real sigue pendiente de ejecutarse en un equipo que tenga PostgreSQL disponible.
