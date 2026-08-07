# Verificación del Sprint 15 — CI con PostgreSQL real

## Cambios realizados

- Sustitución del workflow mínimo por dos jobs independientes.
- Job de calidad: Prisma Client, typecheck, pruebas de seguridad, unit tests y build.
- Job de integración con `services.postgres`.
- Migraciones mediante `prisma migrate deploy`.
- Seed controlado para el smoke test.
- Arranque real de NestJS y espera activa del endpoint de salud.
- Ejecución de `scripts/smoke-live.mjs` contra HTTP real.
- Captura de logs como artefacto cuando existe un fallo.
- Nuevos scripts `db:migrate:ci`, `prisma:migrate:deploy` y `test:ci-config`.

## Comprobaciones ejecutadas en el entorno de preparación

- JSON de los dos `package.json`: válido.
- YAML del workflow: parseable.
- 11 comprobaciones estructurales del job PostgreSQL: superadas.
- Scripts de backup/restore: sintaxis Bash válida.
- `package-lock.json`: sincronizado con los nuevos scripts.

## Limitación

No se puede afirmar que GitHub Actions ha finalizado en verde hasta subir el repositorio y ejecutar el workflow en GitHub. El entorno de preparación no dispone de acceso funcional al registro npm configurado internamente, por lo que `npm ci` no pudo completarse aquí. El workflow fuerza `registry.npmjs.org`, evitando esa configuración específica del entorno de preparación.

## Criterio de cierre

El Sprint 15 queda validado cuando GitHub Actions muestre en verde:

1. `Typecheck, tests and build`.
2. `PostgreSQL migrations and real HTTP smoke test`.
