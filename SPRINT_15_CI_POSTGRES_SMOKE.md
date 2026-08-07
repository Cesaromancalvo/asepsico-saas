# Sprint 15 — CI con PostgreSQL real y smoke test HTTP

## Objetivo

Cerrar la deuda de validación manual mediante un job reproducible de GitHub Actions que levanta PostgreSQL real, aplica las migraciones, arranca la API y ejecuta un recorrido HTTP contra la aplicación viva.

## Workflow

Archivo: `.github/workflows/ci.yml`

El pipeline contiene dos jobs independientes:

1. `quality`: instalación limpia, generación de Prisma, typecheck, pruebas de seguridad/integración, unit tests y build.
2. `postgres-integration`: PostgreSQL 16 como service container, migraciones reales, seed, arranque de NestJS, healthcheck y smoke test HTTP.

## Flujo del job PostgreSQL

1. Levanta `postgres:16-alpine` con healthcheck.
2. Instala dependencias con `npm ci`.
3. Espera a PostgreSQL usando `pg_isready`.
4. Ejecuta `npm run db:generate`.
5. Ejecuta `npm run db:migrate:ci`, que usa `prisma migrate deploy` (seguro y no interactivo para CI).
6. Ejecuta `npm run db:seed` para crear la cuenta de smoke test.
7. Arranca la API NestJS en el puerto 4000.
8. Espera una respuesta válida de `GET /api/v1/health`.
9. Ejecuta `npm run test:smoke` contra HTTP real.
10. Detiene la API y publica sus logs si el job falla.

## Smoke test real

El script existente `scripts/smoke-live.mjs` autentica una cuenta de prueba y verifica persistencia de extremo a extremo mediante HTTP:

- login y cookies;
- creación de paciente;
- historia clínica;
- objetivo y tarea;
- escala clínica;
- documento, consentimiento e informe;
- preferencias de notificación;
- timeline;
- archivo del paciente creado por la prueba.

## Seguridad

- No se usan secretos de producción.
- Las claves JWT son exclusivas del job y distintas entre staff y portal.
- PostgreSQL solo existe durante la ejecución del runner.
- Los permisos del workflow se reducen a `contents: read`.
- Los logs se publican únicamente cuando hay un fallo y se retienen siete días.

## Decisión técnica

En CI se utiliza `prisma migrate deploy`, no `prisma migrate dev`. `migrate deploy` aplica migraciones versionadas sin intentar crearlas ni abrir flujos interactivos, por lo que es el comando apropiado para entornos automatizados.

## Criterio de aprobación

El job solo queda aprobado cuando GitHub Actions muestra en verde:

- `Typecheck, tests and build`;
- `PostgreSQL migrations and real HTTP smoke test`.
