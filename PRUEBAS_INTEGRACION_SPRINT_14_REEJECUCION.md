# Reejecución de integración y pruebas — Sprint 14

Fecha: 28 de julio de 2026

## Alcance

Se ha revisado la integración del Sprint 14 sobre el proyecto consolidado, con foco en:

- exportaciones clínicas y administrativas;
- aislamiento por workspace y por terapeuta;
- auditoría de exportaciones;
- centro de preparación para piloto;
- scripts de backup y restauración;
- regresión estructural del Sprint 13;
- disponibilidad de suites de seguridad existentes.

## Pruebas ejecutadas realmente

### Verificación estructural Sprint 13

Resultado: **8/8 superadas**.

Se comprobó:

- registro de `DashboardModule`;
- controlador `/dashboard`;
- servicio del dashboard;
- migración de onboarding;
- conexión del frontend con `/dashboard`;
- presencia del checklist de primeros pasos.

### Verificación estructural Sprint 14

Resultado: **12/12 superadas**.

Se comprobó:

- módulo, controlador y servicio de exportaciones;
- pantalla `/settings/data`;
- scripts de backup y restauración;
- runbook de piloto;
- registro de `ExportsModule`;
- scoping por workspace;
- restricción de pacientes para terapeutas;
- auditoría de exportaciones.

### Validación sintáctica

Resultado: **superada**.

- `bash -n scripts/backup-postgres.sh`
- `bash -n scripts/restore-check.sh`
- `node --check scripts/smoke-live.mjs`

### Inventario de pruebas de seguridad

Se confirmó la presencia de 13 archivos de configuración/pruebas, incluidos:

- autenticación y refresh;
- facturación;
- mensajería;
- notificaciones;
- acceso a pacientes;
- portal del paciente;
- flujo de tareas;
- exportaciones;
- persistencia de usabilidad.

## Pruebas no completadas en este entorno

### Instalación de dependencias

`npm ci` no terminó dentro del tiempo disponible y no dejó `node_modules` utilizable.

### Typecheck, Jest y build

No pueden considerarse ejecutados correctamente sin dependencias instaladas. El intento de typecheck devolvió errores de módulos ausentes (`@nestjs/*`, `@prisma/client`, `next`, `react`, tipos de Node, etc.), por lo que esos errores no acreditan fallos funcionales del código: acreditan que el entorno carece de dependencias.

### E2E real, backup y restauración

No se ejecutaron contra una instancia PostgreSQL real ni con la aplicación levantada. Por ello no se certifican todavía:

- migraciones reales;
- exportación contra datos persistidos;
- descarga desde navegador;
- backup con `pg_dump`;
- restauración aislada;
- smoke test HTTP completo.

## Estado

**Integración estructural: APROBADA.**

**Validación funcional completa: PENDIENTE DE ENTORNO LOCAL/CI CON DEPENDENCIAS Y POSTGRESQL.**

El Sprint 14 permanece en estado **BETA integrada**, no todavía como Release Candidate de piloto.

## Comandos de cierre recomendados

```bash
npm ci
npm run db:generate
npm run db:migrate
npm run typecheck
npm --workspace @asepsico/api run test:security
npm --workspace @asepsico/api run test:e2e
npm run build
npm run test:smoke
```

Después:

```bash
bash scripts/backup-postgres.sh
bash scripts/restore-check.sh <ruta-del-backup>
```
