# Roadmap maestro de AsePsico

## Propósito

Este documento es la fuente de verdad sobre la numeración, el alcance y el estado real de los sprints de AsePsico.

La numeración se corresponde con los archivos `SPRINT_X_*.md` incluidos en el repositorio. Las ideas antiguas de "IA clínica", "analítica", "RGPD/hardening" y "despliegue/beta" dejan de ocupar los números 9–12 porque esos números ya fueron utilizados por funcionalidades efectivamente desarrolladas.

## Estados utilizados

- **Implementado**: el código y, cuando aplica, la migración están incorporados.
- **Pruebas incluidas**: existen pruebas automáticas o verificaciones específicas en el repositorio.
- **Ejecución confirmada**: las pruebas indicadas se ejecutaron y existe evidencia documental.
- **BETA**: funcionalidad integrada, pero todavía requiere validación local completa, E2E o endurecimiento antes de piloto.
- **Validado**: existe evidencia suficiente de integración y regresión para el alcance declarado.

## Tabla maestra corregida

| Etapa | Módulo real | Archivo principal | Estado de desarrollo | Evidencia disponible | Estado global |
|---|---|---|---|---|---|
| Base | Arquitectura, autenticación, CSRF, roles y multi-tenant | `docs/ARCHITECTURE.md`, `docs/SECURITY_BASELINE.md` | Implementado | Revisiones de seguridad y suites acumuladas | Parcialmente validado |
| Sprint 1 | Historia clínica | `SPRINT_1_CLINICAL_HISTORY.md` | Implementado | Incluido en suite inicial 13/13 | Validado dentro de regresión |
| Sprint 2 | Plan terapéutico y evolución | `SPRINT_2_PLAN_Y_EVOLUCION.md` | Implementado | Incluido en suite inicial 13/13 | Validado dentro de regresión |
| Sprint 3 | Tareas terapéuticas | `SPRINT_3_TAREAS_TERAPEUTICAS.md` | Implementado | Revisiones de seguridad y regresión | Validado dentro de regresión |
| Sprint 4 | Escalas clínicas | `SPRINT_4_ESCALAS_CLINICAS.md` | Implementado | Incluido en suite inicial 13/13 | Validado dentro de regresión |
| Sprint 5 | Documentos, consentimientos e informes | `SPRINT_5_DOCUMENTOS_CONSENTIMIENTOS_INFORMES.md` | Implementado | Pruebas añadidas; validación local incompleta | BETA |
| Sprint 6 | Facturación y pagos | `SPRINT_6_FACTURACION_Y_PAGOS.md` | Implementado | 25/25 pruebas de seguridad e integración | Validado dentro del alcance probado |
| Sprint 7 | Portal del paciente | `SPRINT_7_PORTAL_DEL_PACIENTE.md` | Implementado | 29/29 pruebas; frontend typecheck superado | Validado con limitaciones documentadas |
| Sprint 8 | Notificaciones y recordatorios | `SPRINT_8_NOTIFICACIONES_RECORDATORIOS.md` | Implementado | 34/34 pruebas; frontend typecheck superado | Validado con limitaciones documentadas |
| Sprint 9 | Ficha clínica unificada | `SPRINT_9_FICHA_CLINICA_UNIFICADA.md` | Implementado | Verificación funcional pendiente de cierre completo | BETA |
| Sprint 10 | Recursos terapéuticos | `SPRINT_10_RECURSOS_TERAPEUTICOS.md` | Implementado | Biblioteca, compartición, portal y auditoría; subida binaria segura pendiente | BETA |
| Sprint 11 | Mensajería estructurada | `SPRINT_11_MENSAJERIA_ESTRUCTURADA.md` | Implementado | 9 suites, 48/48 pruebas | Validado dentro del alcance probado |
| Sprint 12 | Flujo completo de tareas terapéuticas | `SPRINT_12_FLUJO_COMPLETO_TAREAS.md` | Implementado | 10 suites, 52/52 pruebas; E2E manual pendiente | BETA avanzada |
| Sprint 13 | Dashboard profesional y onboarding | `SPRINT_13_DASHBOARD_ONBOARDING.md` | Implementado | 8/8 verificaciones estructurales | BETA |
| Sprint 14 | Exportaciones, backups y preparación para piloto | `SPRINT_14_EXPORTACIONES_BACKUPS_PILOTO.md` | Implementado | 11 suites, 58/58 tests; 12/12 verificaciones; backup/restore real ejecutado | BETA avanzada |

## Evidencia acumulada relevante

### Seguridad e integración

- Sprint 6: **25/25** pruebas.
- Sprint 7: **29/29** pruebas.
- Sprint 8: **34/34** pruebas.
- Puerta de calidad posterior al Sprint 8: **39/39** pruebas.
- Sprint 11: **48/48** pruebas.
- Sprint 12: **52/52** pruebas.
- Sprint 14: **11 suites, 58/58 tests y 0 fallos**.

### Backup y restauración

El proceso de backup y restauración ya no figura como pendiente absoluto:

- PostgreSQL 16 real utilizado.
- 14 migraciones SQL aplicadas.
- 27 tablas restauradas.
- Huella de origen y restauración con **0 diferencias**.
- Paciente de prueba verificado después de `pg_restore`.
- Bug del script `test-backup-restore.sh` detectado y corregido durante la ejecución real.

Evidencia: `PRUEBA_3B_BACKUP_RESTORE_EJECUTADO.md`.

Pendiente posterior: repetir la prueba con un volumen de datos representativo y medir tiempos de recuperación.

### Refactorización del dominio de pacientes

El antiguo `patients.service.ts` de más de 1.000 líneas fue dividido en servicios especializados:

- acceso clínico;
- núcleo de pacientes;
- historia y objetivos;
- tareas;
- escalas;
- documentos, consentimientos e informes;
- fachada de compatibilidad.

Evidencia: `PRUEBA_4_REFACTORIZACION_PATIENTS_SERVICE.md`.

## Detalle por sprint

### Sprint 1 — Historia clínica

Historia clínica privada por paciente, con acceso restringido, auditoría y persistencia.

### Sprint 2 — Plan terapéutico y evolución

Objetivos terapéuticos, prioridades, estados, fechas y línea temporal clínica.

### Sprint 3 — Tareas terapéuticas

Primera versión de tareas entre sesiones, estados, asociación con objetivos y seguimiento.

### Sprint 4 — Escalas clínicas

PHQ-9, GAD-7 y WHO-5, cálculo de puntuaciones, evolución y alertas prudentes.

### Sprint 5 — Documentos, consentimientos e informes

Gestión documental, consentimientos y generación de informes con trazabilidad.

### Sprint 6 — Facturación y pagos

Facturas, emisión, pagos parciales, reversión, idempotencia y resumen económico.

### Sprint 7 — Portal del paciente

Cuenta independiente, citas, tareas, consentimientos y facturas sin exponer narrativa clínica privada.

### Sprint 8 — Notificaciones y recordatorios

Bandejas, preferencias, recordatorios, deduplicación, auditoría y preparación de canales externos.

### Sprint 9 — Ficha clínica unificada

Centro operativo del paciente con resumen, próxima acción, sesiones, objetivos, tareas, escalas y actividad reciente.

### Sprint 10 — Recursos terapéuticos

Biblioteca reutilizable, compartición por paciente, retirada de acceso e integración con portal.

Pendiente para piloto: subida binaria privada a MinIO, antivirus, límites de tamaño y URLs temporales.

### Sprint 11 — Mensajería estructurada

Conversaciones asíncronas profesional-paciente, límites visibles, cierres, archivo, no leídos y notificaciones prudentes.

### Sprint 12 — Flujo completo de tareas

Borrador, asignación, progreso, entrega, revisión, solicitud de cambios, finalización y plantillas.

### Sprint 13 — Dashboard y onboarding

Agenda diaria, pendientes, mensajes, pacientes sin próxima cita y checklist de puesta en marcha.

### Sprint 14 — Exportaciones, backups y preparación para piloto

Exportación por paciente y workspace, centro de datos, scripts operativos, runbook y validación real de backup/restore.

## Trabajo posterior al Sprint 14

Los siguientes bloques dejan de estar numerados como Sprints 9–12. Se consideran una nueva fase posterior al roadmap funcional ya ejecutado.

### Sprint 15 — CI con PostgreSQL real

Estado: **implementado; pendiente de primera ejecución verde en GitHub Actions**.

Incluye:

- servicio `postgres:16-alpine` dentro de GitHub Actions;
- instalación limpia con `npm ci`;
- `db:generate`;
- migraciones reales mediante `prisma migrate deploy`;
- seed de una cuenta controlada;
- arranque real de la API NestJS;
- comprobación de `GET /api/v1/health`;
- smoke test HTTP completo con persistencia;
- publicación de logs cuando el job falla;
- job separado de calidad con typecheck, tests de seguridad, unit tests y build.

El sprint solo se marcará como validado cuando ambos jobs aparezcan en verde en GitHub Actions.

### Fase B — Hardening RGPD y preparación jurídica

Pendiente de definición y revisión especializada:

- DPIA;
- DPA y subencargados;
- conservación y bloqueo;
- derechos de acceso, rectificación y portabilidad;
- MFA;
- sesiones revocables;
- inventario de tratamientos;
- procedimiento de brechas.

### Fase C — Estabilización prepiloto

- instalación limpia reproducible;
- typecheck completo;
- builds de Nest y Next;
- E2E en navegador;
- accesibilidad de flujos críticos;
- observabilidad sin contenido clínico;
- prueba de restauración con volumen representativo;
- revisión independiente de seguridad.

### Fase D — Funcionalidades futuras sujetas a evidencia

Sin numeración reservada hasta nueva decisión del CEO:

- analítica de producto y gestión;
- IA clínica asistida;
- integraciones externas;
- funciones avanzadas para clínicas.

Estas funcionalidades no deben introducirse antes de cerrar la estabilización y demostrar necesidad mediante piloto.

## Regla de mantenimiento

Cuando se cierre un sprint o una fase:

1. El nombre de la tabla debe coincidir con el archivo real.
2. El estado debe reflejar evidencia ejecutada, no intención.
3. Una funcionalidad BETA no se marca como validada sin pruebas suficientes.
4. Las ideas futuras no deben reutilizar números ya ocupados.
5. Cualquier renumeración requiere actualizar tabla, secciones y nombres de archivo de forma conjunta.
