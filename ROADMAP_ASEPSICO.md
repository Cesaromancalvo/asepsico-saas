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
| Sprint 15 | CI con PostgreSQL real y smoke HTTP | `SPRINT_15_CI_POSTGRES_SMOKE.md` | Implementado | `COMPROBACION_EJECUCION_SPRINT_15.md`, `PRUEBA_SPRINT_15_CI_POSTGRES.md` | Ver sección Sprint 15 |
| Sprint 16 | Despliegue del piloto demo (sesión 3, 16–17/10/2026) | `SPRINT_16_DESPLIEGUE_PILOTO_DEMO.md` | Implementado (PR #19–#23 en `main`) | Revisión de Argos; PR #23: `test:security` 1174/1176 sin fallos, web 42/42, e2e Postgres 27/27; CI con 3 checks en verde en cada merge; copia previa restaurada (`pg_restore` código 0) | BETA (solo demo, sin datos reales) |
| Sprint 17 | Acceso excepcional y reserva de citas desde el portal (entrega S4) | Sin documento propio (PR #28) | Implementado (PR #28 en `main`, 19/10/2026); desplegado el 19/10/2026 | Evidencia en el PR #28 (cifras de tests no recogidas en este roadmap); verificaciones en vivo en `postgres-integration`; migraciones de 30 a 33 | BETA (solo demo, sin datos reales) |
| Sprint 18 | Alta en el portal con QR y baja de miembros del equipo (entrega S5) | `SPRINT_18_ALTA_PORTAL_QR_Y_BAJA_MIEMBRO.md` | Implementado (PR #34 en `main`, `346e1fe`); desplegado el 21/10/2026 | Argos aprobado; `test:security` 1448/1448 con PostgreSQL real, web 136/136, smoke y verificaciones en vivo del CI en verde, prueba manual HTTP 21/21; producción de 33 a 37 migraciones con copia previa; comprobaciones posteriores al despliegue sin datos reales | BETA (solo demo, sin datos reales); flujo completo del alta por QR y de la baja en el entorno pendiente |

## Evidencia acumulada relevante

### Seguridad e integración

- Sprint 6: **25/25** pruebas.
- Sprint 7: **29/29** pruebas.
- Sprint 8: **34/34** pruebas.
- Puerta de calidad posterior al Sprint 8: **39/39** pruebas.
- Sprint 11: **48/48** pruebas.
- Sprint 12: **52/52** pruebas.
- Sprint 14: **11 suites, 58/58 tests y 0 fallos**.
- Sprint 16 (PR #23, cambio de contraseña): `test:security` **1174/1176 sin fallos**, web **42/42**, e2e con PostgreSQL **27/27**; tres checks del CI en verde en cada merge.
- Sprint 18 (entrega S5): `test:security` con PostgreSQL real **1448/1448**, web **136/136**, smoke HTTP y verificaciones en vivo del CI en verde, prueba manual HTTP **21/21**.

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

### Entre el Sprint 15 y el Sprint 16 (sin documento de sprint propio)

Fusionados en `main` los PR #5–#18: correcciones de seguridad (escrituras acotadas por workspace, ciclo de vida de pacientes, portal, MFA, `TRUST_PROXY`, cifrado de campos clínicos, exposición de motivo de consulta y procesos), acceso clínico E1, importación de pacientes, web pública y lista de espera propia. Su detalle vive en los PR y en `docs/SECURITY_BASELINE.md`; no tienen documento `SPRINT_X_*.md` y no se marcan aquí como validados.

### Sprint 16 — Despliegue del piloto demo (sesión 3)

Estado: **Implementado; BETA solo para demo (sin datos de pacientes reales)**.

Incluye en `main`: registro por invitación, condiciones `demo-1.1`, marcas `isDemo` con seed y purga del espacio demo, web de registro, condiciones y aviso de entorno demo, control de cobros, citas entre profesionales, login sin credenciales de ejemplo, web pública con formulario propio de lista de espera, calculadora, rediseño visual y cambio de contraseña de los profesionales (PR #23). Migraciones de 27 a 30. El CLI `users:set-password` queda fuera de `main` a propósito (se ejecuta desde un clon).

Ejecutado en el entorno (16/10/2026): rotación de la contraseña del titular con 0 sesiones activas, cambio de plan de la base de datos con copia previa (31 tablas) restaurada con `pg_restore` código 0, variables `LEGAL_TITULAR_*` y `DEMO_ENVIRONMENT`, condiciones aceptadas, espacio demo con 10 pacientes ficticios, registro cerrado verificado, web estática con 6 cabeceras de seguridad y sin cookies, y C3 (logs del proveedor) cerrada por Lex Psi.

Pendiente antes de invitar a nadie:

- revisión operativa del espacio demo antes de la primera invitación (pendiente);
- backlog de Argos: invalidar access tokens tras cambiar la contraseña (`tokenVersion`/`passwordChangedAt`; **resuelto en el Sprint 18, desplegado el 21/10/2026**) y `RegisterDto` con `MaxUtf8Bytes(72)`/`MinChars(12)`;
- plan de la API: decisión pendiente (la API tarda unos 72 s en despertar tras un rato sin uso; la base de datos tiene desde el 16/10/2026 copias del proveedor y copias propias cifradas);
- salida de Vercel antes del 31/10/2026;
- acceso excepcional: **en `main` y desplegado con el Sprint 17** (19/10/2026).

### Sprint 17 — Acceso excepcional y reserva de citas desde el portal (entrega S4)

Estado: **Implementado y desplegado el 19/10/2026; BETA solo para demo (sin datos de pacientes reales)**.

Fusionado en `main` con el PR #28 (`feat/s4-integracion`): acceso excepcional a la historia clínica (API y web, con registro y avisos) y reserva de citas desde el portal del paciente (disponibilidad del profesional, huecos, solicitudes, bandeja y "Pedir cita"), más las verificaciones en vivo de ambas en el job `postgres-integration` del CI. Migraciones de 30 a 33. No tiene documento `SPRINT_X_*.md` propio: el detalle vive en el PR y en `docs/SECURITY_BASELINE.md`, y las cifras de tests de esta entrega no se recogen aquí.

### Sprint 18 — Alta en el portal con QR y baja de miembros del equipo (entrega S5)

Estado: **Implementado y desplegado el 21/10/2026; BETA solo para demo (sin datos de pacientes reales)**. Documento: `SPRINT_18_ALTA_PORTAL_QR_Y_BAJA_MIEMBRO.md`.

Despliegue (21/10/2026, hacia las 21:40): PR #34 (`docs/s5`, `a0c30e9`; merge `346e1fe`). Producción de 33 a 37 migraciones, con copia previa y ensayo previo de las migraciones sobre esa copia restaurada. Comprobaciones posteriores, sin datos reales: `health` correcto, las 4 rutas nuevas protegidas responden 401, la ruta pública del QR responde 202 genérico con un token inventado, una activación inválida responde 400 y el entorno sigue marcado como demo. El Jefe revisó las pantallas nuevas. **No consta todavía** la prueba en el entorno del alta por QR de principio a fin ni de la baja de un miembro con su `SESSION_REVOKED` (criterio de aprobación del documento del sprint).

Incluye: alta del paciente en el portal con el QR fijo de cada profesional (solicitud pendiente cifrada, bandeja «Altas del portal», vincular/crear/rechazar/rechazo masivo, confirmación 409 con `confirmWarnings`, enlace de activación de 72 h entregado solo en persona, 18 años mínimo con QR y purga automática a los 14 días); baja de miembros (`REMOVED`, `tokenVersion` y 401 `SESSION_REVOKED`, reasignación o «decidir después», avisos a OWNER/ADMIN y notas internas del anterior archivadas sin vía de lectura); pantallas web y cabeceras `no-referrer`/`noindex`. Migraciones de 33 a 37, todas aditivas.

Pendiente:

- **antes de pacientes reales:** endpoint público con los datos del responsable (H1) y revisión por abogado de los textos v1.0 del alta;
- **antes de que un cliente real se dé de baja:** exportación clínica completa (H1), con las notas internas archivadas;
- producto: lectura de notas archivadas por acceso excepcional, reincorporación de miembros y aviso «Próxima cita» en citas sin reasignar.

### Correcciones desplegadas el 21/10/2026 (sin documento de sprint propio)

- PR #31 (`18f7813`): interruptor de la reserva desde el portal con el estilo de Ajustes > Equipo y campo del código MFA sin autorrelleno.
- PR #32 (`babe7c2`): el campo del código MFA solo acepta lo que teclea o pega la persona (Safari).
- PR #33 (`4695ef7`): la web pública despierta la API al cargar y el formulario de la lista de espera aguanta el arranque en frío (antes se rendía a los 30 s y la API tarda unos 72 s en despertar).

Fusionados en `main` el 20 y el 21/10 y desplegados el 21/10. Sus cifras de tests viven en cada PR y no se recogen aquí.

### Fase B — Hardening RGPD y preparación jurídica

Pendiente de definición y revisión especializada:

- DPIA;
- DPA y subencargados;
- conservación y bloqueo;
- derechos de acceso, rectificación y portabilidad;
- MFA;
- sesiones revocables (revalidación en cada petición con `tokenVersion` y membresía activa implementada en el Sprint 18 y desplegada el 21/10/2026);
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
