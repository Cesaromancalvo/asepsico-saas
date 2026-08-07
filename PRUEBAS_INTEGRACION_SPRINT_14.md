# Pruebas de integración y funcionamiento — Sprint 14

## Alcance

Validación del Sprint 14 de AsePsico: exportaciones clínicas y administrativas, preparación para piloto, scripts de backup/restauración y regresión de seguridad de los sprints anteriores.

## Resultado ejecutivo

Estado: **BETA validada parcialmente**.

- Verificaciones estructurales Sprint 13: **8/8 superadas**.
- Verificaciones estructurales Sprint 14: **12/12 superadas**.
- Typecheck frontend: **superado**.
- Suite de seguridad e integración: **11 suites, 58 tests, 0 fallos**.
- Nuevos tests específicos Sprint 14: **6/6 superados**.
- Sintaxis de scripts de backup/restauración: **correcta**.
- Typecheck API: **pendiente por cliente Prisma no regenerado**.
- Build Next.js: **no completado por fallo externo de descarga SWC (HTTP 503)**.
- Prueba real de backup/restauración y E2E con PostgreSQL: **no ejecutable en este entorno**.

## Pruebas añadidas para Sprint 14

Archivo añadido:

`apps/api/test/exports.security-spec.ts`

Casos cubiertos:

1. El terapeuta solo puede exportar pacientes de su workspace y asignados a su proceso clínico.
2. Un paciente no accesible devuelve `NotFound` para evitar filtración de existencia.
3. Los roles no clínicos no pueden exportar información clínica.
4. Solo `OWNER` y `ADMIN` pueden exportar el workspace y consultar preparación de piloto.
5. La auditoría de exportación no copia contenido clínico sensible en sus metadatos.
6. Los indicadores de preparación para piloto se calculan con filtros por workspace.

## Regresión de seguridad

Comando ejecutado:

```bash
npm --workspace @asepsico/api run test:security
```

Resultado:

```text
Test Suites: 11 passed, 11 total
Tests:       58 passed, 58 total
Snapshots:   0 total
```

Incluye las suites previas de autenticación, pacientes, portal, mensajería, notificaciones, facturación, tareas y persistencia de usabilidad.

## Integración estructural

Comandos ejecutados:

```bash
node scripts/verify-sprint13.mjs
node scripts/verify-sprint14.mjs
bash -n scripts/backup-postgres.sh
bash -n scripts/restore-check.sh
node --check scripts/smoke-live.mjs
```

Resultado: todas las comprobaciones superadas.

Se verificó:

- registro de `ExportsModule`;
- controlador y servicio de exportaciones;
- aislamiento por workspace;
- restricción de pacientes asignados al terapeuta;
- auditoría de exportaciones;
- pantalla `/settings/data`;
- scripts de backup y restauración;
- runbook de piloto.

## Typecheck frontend

Comando:

```bash
npm --workspace @asepsico/web run typecheck
```

Resultado: **superado sin errores**.

## Limitaciones encontradas

### Prisma

`prisma generate` no pudo descargar el binario desde `binaries.prisma.sh` por un error DNS `EAI_AGAIN`. Por ello el cliente Prisma disponible quedó desactualizado y el typecheck de la API muestra propiedades de modelos nuevos como inexistentes.

Esto no demuestra un fallo del código del Sprint 14; requiere regenerar Prisma en un entorno con acceso a la descarga de binarios.

### Build web

`next build` intentó descargar `@next/swc-linux-x64-gnu` y recibió HTTP 503. El typecheck del frontend sí se completó correctamente.

### PostgreSQL y E2E

El entorno no dispone de Docker, `psql` ni `pg_dump`. No fue posible ejecutar:

- migraciones contra PostgreSQL real;
- exportación HTTP con datos reales;
- backup real;
- restauración en base aislada;
- smoke test de frontend + API.

## Validación definitiva recomendada en local

```bash
npm ci
npm run db:generate
npm run db:migrate
npm --workspace @asepsico/api run typecheck
npm --workspace @asepsico/web run typecheck
npm --workspace @asepsico/api run test:security
npm run build
npm run test:smoke
```

Después:

```bash
./scripts/backup-postgres.sh
./scripts/restore-check.sh <ruta-del-backup>
```

## Conclusión

El Sprint 14 supera la integración estructural, el typecheck frontend y la regresión de seguridad, incluyendo pruebas específicas nuevas para exportaciones y preparación del piloto. No debe marcarse todavía como versión candidata definitiva hasta completar Prisma, migraciones, build, E2E y restauración real en un entorno local con PostgreSQL.
