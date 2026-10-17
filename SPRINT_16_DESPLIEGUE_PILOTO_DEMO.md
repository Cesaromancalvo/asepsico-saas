# Sprint 16 — Despliegue del piloto demo (sesión 3, 16–17/10/2026)

## Objetivo

Dejar en `main` todo lo necesario para abrir un **piloto demo** (sin datos de pacientes reales) y ejecutar la tercera sesión de despliegue: registro solo por invitación, condiciones versionadas `demo-1.1`, espacio demo con pacientes ficticios, web pública propia y endurecimiento de la cuenta del titular.

Este documento registra lo fusionado en `main` y lo ejecutado en el entorno desplegado. No declara nada como validado para datos clínicos reales: el entorno es **demo**.

## Qué incluye

### Fusionado en `main` (referencia: `7cf1add`)

| PR | Merge | Contenido |
|---|---|---|
| #20 Piloto demo | `df8fc4c` | Registro por invitación (`invites:create`, de un solo uso, caduca a los 14 días). Condiciones y política de privacidad del piloto demo `demo-1.1` con aceptación auditada y 428 `TERMS_ACCEPTANCE_REQUIRED`. Marcas `isDemo`, seed y purga del espacio demo (`db:seed-demo-workspace`, `db:purge-demo-workspace`). Web de registro, página de condiciones y aviso fijo de entorno demo (`GET /api/v1/environment`). "Control de cobros". Citas entre profesionales. Login sin credenciales de ejemplo y seed bloqueado en producción. Arreglo de Vercel `03929bc` (dependencia `@asepsico/contracts` + `transpilePackages`). |
| #19 Web nueva | `9f38074` | Formulario propio de lista de espera (sustituye al formulario externo), NIF y domicilio del titular inyectados solo al publicar con `apps/landing/build.mjs` (fuera del repositorio) y página 404 propia. `f6e279d` retira los comentarios internos de la web publicada. |
| #21 Calculadora | `701b4ed` | Se enciende la cuenta "Lo que te cuesta hoy" en la web pública. |
| #22 Rediseño visual | `193325b` (rama `feat/rediseno-visual`, `0a5cef5`) | Sistema visual v1: tokens de marca, tipografía, barra lateral clara, chips y estados vacíos aplicados a Mi jornada, Agenda, ficha/proceso, portal y resto de pantallas. |
| #23 Cambio de contraseña para profesionales | `7cf1add` (rama `feat/cambiar-contrasena`) | `POST /auth/change-password` y pantalla `/settings/security`. Aprobado por Argos con condiciones de backlog y verificado por Quima. |

**Migraciones:** el PR #20 añade tres migraciones versionadas (`registro_por_invitacion`, `add_demo_markers`, `strip_reason_from_billing_audit`). `main` pasa de 27 a 30 migraciones.

### Fuera de `main` a propósito

| Herramienta | Rama | Contenido | Estado |
|---|---|---|---|
| CLI `users:set-password` | `dora/cli-set-password` (`4ce4e01`) | Cambio de contraseña de un profesional desde terminal, con condiciones de Argos (confirmación del correo, solo TTY) | Usado en el bloque 0. Se ejecuta desde un clon y **no se despliega**; por decisión no se fusiona en `main`. |

### Operaciones de la sesión 3 (16/10/2026)

1. **Bloque 0 — cuenta del titular.** Revisión de la cuenta sin accesos ajenos y rotación de su contraseña con el CLI `users:set-password`. Tras la rotación: 0 sesiones activas.
2. **Base de datos:** cambio de plan con copia previa y prueba de restauración.
3. **Variables de entorno** `LEGAL_TITULAR_*` (datos del titular, solo en el panel del proveedor) y `DEMO_ENVIRONMENT`.
4. **Condiciones `demo-1.1` aceptadas** por el titular.
5. **Espacio demo sembrado** con 10 pacientes ficticios.
6. **Registro cerrado verificado:** sin invitación no se puede crear cuenta.
7. **Web pública** como Static Site (`node build.mjs`, publica `dist`) con 6 cabeceras de seguridad.
8. **Sin cookies** en la web pública.
9. **C3 cerrada por Lex Psi:** en el plan contratado Render no ofrece request logs; los logs de la aplicación se conservan 7 días y no hay Log Streams configurados.

## Seguridad

- **Argos** revisó los cambios del PR #20 (levantó el veto tras `893efa3` y `c0179a1`: seed bloqueado en producción, sin contraseña fija y sin credenciales demo en el login) y aprobó el PR #23 con condiciones de backlog (abajo).
- Ningún dato del titular (NIF, domicilio) ni ninguna credencial está en el repositorio: se inyectan desde variables del proveedor al arrancar la API o al publicar la web. Los textos con marcadores sin rellenar responden 503 `LEGAL_TERMS_DRAFT` en producción.
- El contrato art. 28 no está vigente durante el demo: **no debe haber datos de pacientes reales** en este entorno.
- El espacio demo solo contiene datos ficticios, marcados con `isDemo` y purgables.

### Cambio de contraseña (PR #23)

- Exige la contraseña actual y, con MFA activo, un código TOTP no usado (no acepta códigos de recuperación). OWNER/ADMIN/THERAPIST sin MFA reciben 403 `MFA_SETUP_REQUIRED`; los tokens del portal reciben 401.
- En una transacción: nuevo hash (bcrypt coste 12, 12 caracteres mínimo, 72 bytes máximo), revocación de **todos** los refresh tokens del usuario, auditoría `USER_PASSWORD_CHANGED` sin datos personales y sesión nueva para el navegador actual.
- **Limitación aceptada por Argos:** los access tokens ya emitidos en otros dispositivos siguen siendo válidos hasta que caducan, como máximo **15 minutos** después del cambio. Esa ventana se cierra con el punto de backlog `tokenVersion`/`passwordChangedAt`.

## Decisiones técnicas

- La sesión no tiene número de sprint propio en el plan funcional; se documenta como **Sprint 16** por ser el siguiente número libre (el último documento es el Sprint 15).
- Con el PR #23 ya en `main`, `docs/SECURITY_BASELINE.md` recoge el cambio de contraseña y la ventana de 15 minutos de los access tokens ya emitidos, como limitación conocida.
- El CLI `users:set-password` no entra en `main`: es una herramienta operativa que se ejecuta desde un clon local.
- Las decisiones de coste, plan y proveedor son del Jefe y se documentan fuera del repositorio.

## Evidencia y cifras

- **Verificación de Quima del PR #23 (cambio de contraseña):** `test:security` 1174/1176 sin fallos (2 no ejecutadas, ninguna fallida), tests de la web 42/42 y e2e con PostgreSQL 27/27.
- **CI:** los tres checks en verde en cada merge de esta entrega (`Typecheck, tests and build`, `PostgreSQL migrations and real HTTP smoke test` y el despliegue de Vercel).
- **Copia previa a la sesión 3:** 116 KB y 31 tablas; restaurada en una base limpia con 27 migraciones y `pg_restore` terminado con código 0.
- **Operaciones de la sesión 3:** ejecutadas por el Jefe con Dora y Lex Psi. No hay en el repositorio un registro de salida de comandos de esta sesión.

## Pendiente antes de invitar a nadie

- **Revisión operativa del espacio demo antes de la primera invitación** (pendiente).
- **Plan de la API:** decisión pendiente.
- **Salida de Vercel** de la app web antes del 31/10/2026.

## Backlog de Argos (condiciones del PR #23)

- Invalidar los access tokens tras cambiar la contraseña (`tokenVersion` o `passwordChangedAt` comprobado en el guard).
- `RegisterDto` (y alta de miembros) con `MaxUtf8Bytes(72)` y `MinChars(12)`, la misma política que el cambio de contraseña.

## En curso

- **Acceso excepcional:** backend aprobado por Argos y verificado por Quima en `feat/acceso-excepcional`; la interfaz está en desarrollo en `feat/acceso-excepcional-web`. No está en `main`.

## Criterio de aprobación

La sesión 3 se considera **cerrada para demo** cuando:

- `main` contiene los PR #19, #20, #21, #22 y #23 con los tres checks del CI en verde (cumplido);
- el entorno demo tiene condiciones `demo-1.1` aceptadas, espacio demo con datos ficticios y registro cerrado (cumplido);
- la baseline de seguridad recoge el cambio de contraseña y su ventana de 15 minutos (cumplido);
- se ha hecho la revisión operativa del espacio demo antes de la primera invitación (**pendiente**).

Hasta entonces, el estado es **Implementado, BETA (demo)**, no Validado.
