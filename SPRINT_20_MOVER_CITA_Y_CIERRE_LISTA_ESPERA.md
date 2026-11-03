# Sprint 20 — «Mover cita», contraseñas por soporte y cierre de la lista de espera v5 (28–30/10/2026)

## Objetivo

Cerrar lo que faltaba en la agenda y en la operación del piloto demo (solo datos inventados) antes de las primeras demostraciones:

1. **Mover una cita** desde la agenda (fecha, hora y duración), con las mismas garantías que el alta de citas.
2. **Restablecer la contraseña** (y, si hace falta, la verificación en dos pasos) de una cuenta por soporte, sin que la app tenga «He olvidado mi contraseña».
3. **Retirar las versiones antiguas** de la política de la lista de espera: solo se acepta `lista-espera-v5`.
4. Cerrar las pruebas pendientes del Sprint 19 y los arreglos de «Mi jornada» detectados al preparar las demostraciones.

Este documento registra lo fusionado en `main` del 28 al 30/10/2026 con los PR #48 a #52 (HEAD `4057655`). No declara nada como validado para datos clínicos reales.

Numeración: el último documento de sprint es el 19 (PR #43–#47). El PR #49 es el propio documento del Sprint 19; el resto de esta entrega toma el número **20**.

## Qué incluye

### PR #48 — Pruebas pendientes del Sprint 19 (merge `796a57a`, 28/10/2026)

- **Portal sin preferencias de avisos (A1):** `apps/web/test/portal-no-preferences.spec.tsx` carga el portal con `fetch` simulado y comprueba que pide panel, avisos y mensajes, pero nunca `/portal/notifications/preferences`, y que el código no contiene el bloque de correo o SMS. Falla con la versión anterior al arreglo.
- **CSRF del borrado del teléfono de la lista de espera:** `POST /admin/waitlist/:id/phone/delete` responde 403 sin cabecera CSRF, sin cookie o con valores que no coinciden, aunque sea `PLATFORM_ADMIN` con la contraseña correcta; el teléfono no se borra y no se audita. Casos de la v5 (sin teléfono → 400 `WAITLIST_PHONE_REQUIRED`; con teléfono → 202).
- **CI:** el spec de transición de cookies (`auth-cookies-transition-db`) tiene paso propio en `postgres-integration` con base de datos obligatoria, para que no se omita en silencio.

### PR #49 — Documento del Sprint 19 y roadmap (merge `cbba29a`, 28/10/2026)

Solo documentación: `SPRINT_19_SALIDA_VERCEL_Y_ARREGLOS_PREPILOTO.md` y `ROADMAP_ASEPSICO.md`.

### PR #50 — CLI `users:set-password` (merge `6493620`, 28/10/2026)

CLI de operador (`npm run users:set-password -- --email …`) para rotar las cuentas demo y restablecer el acceso de una profesional del piloto. Procedimiento en `ops/PILOT_RUNBOOK.md`.

- En una sola transacción: hash bcrypt de coste 12, sube `tokenVersion` y `passwordChangedAt`, pone a cero los fallos de MFA, revoca todos los refresh tokens y audita `USER_PASSWORD_RESET_CLI` (y `USER_MFA_RESET_CLI` con `--reset-mfa`) sin correo, IP, contraseña ni secreto.
- `--reset-mfa` borra el TOTP y los códigos de recuperación; los roles que lo exigen tienen que volver a configurarlo en el siguiente acceso.
- Por defecto solo actúa sobre cuentas `isDemo`. Una cuenta real exige `--allow-non-demo`, el correo por teclado (no por argumentos) y escribir `VERIFICADA` tras la comprobación de identidad que describe el runbook.
- Condiciones de la revisión de seguridad incorporadas: muestra el espacio y el rol de cada membresía y pide repetir el correo antes de pedir la contraseña; exige terminal (sin modo tubería); las opciones desconocidas abortan antes de conectar.
- Tests: `users-set-password-cli.security-spec.ts` (unitario y proceso real) y `users-set-password-db.security-spec.ts` (PostgreSQL real, en `postgres-integration`).

### PR #51 — «Mover cita» (API y web) y arreglos de «Mi jornada» (merge `4057655`, 30/10/2026)

**API (`apps/api`)** — contrato completo en `docs/SESSION_RESCHEDULE_API.md`.

- `PATCH /sessions/:id/reschedule` con `startsAt` y `endsAt` obligatorios (ISO con zona). `OWNER`, `ADMIN` y `ASSISTANT` mueven cualquier cita del espacio; `THERAPIST`, solo las suyas (403 `NOT_OWN_SESSION`, auditado como acceso denegado).
- Solo citas programadas, no empezadas, a una hora futura y con proceso activo; errores con código estable (`START_IN_PAST`, `NO_CHANGE`, `SESSION_OVERLAP`, `PROCESS_NOT_ACTIVE`, `SLOT_NOT_AVAILABLE`…).
- Mismo bloqueo de agenda que la aprobación de solicitudes del portal; relectura de la cita con el bloqueo tomado.
- Auditoría `SESSION_RESCHEDULED` con la hora antigua y la nueva, sin contenido clínico, en la misma transacción.
- Las solicitudes del portal pendientes sobre esa cita se cierran (rechazadas con «contactar con la consulta»), se libera el hueco y se auditan.
- **Aviso al paciente solo dentro del portal** («Tu cita ha cambiado: nueva fecha …», en la zona horaria del espacio), también visible para su tutor, sin profesional, proceso ni dato clínico. **No se envía correo ni SMS.**
- El `PATCH /sessions/:id` heredado comparte las reglas; sin hora nueva responde 400 `NO_CHANGE`.
- Sin migraciones.

**Web (`apps/web`)**

- Botón **«Cambiar fecha u hora»** en el detalle de una cita futura y en su tarjeta de la vista semanal. Formulario de fecha, hora y duración con la zona horaria de la consulta; aviso de que se cierran las solicitudes pendientes del paciente; mensajes claros por código de error (los 400 sin código muestran un mensaje genérico, nunca el texto del servidor).
- Al guardar: «Cita movida al …» con enlace **«Ver en la agenda»**; la semana salta a la de destino y resalta la cita.
- **«Nueva cita»** desde «Mi jornada» y desde la ficha abre el formulario (`?new=true`, `?patientId=` con el paciente preseleccionado).
- **«Tareas por revisar»** lleva a las tareas entregadas con el filtro «Por revisar» (un paciente) o a la nueva lista `/follow-up/revisar/` (varios; muestra las 5 entregas que más tiempo llevan esperando y lo indica). Recepción y quien no atiende pacientes ven «Solo para profesionales» sin consultar el panel clínico.

**CI**: los tests de carrera de `session-reschedule` y `dashboard-task-review` se ejecutan en `postgres-integration` con base de datos obligatoria; `test:ci-config` exige el patrón actualizado.

### PR #52 — Lista de espera: solo `lista-espera-v5` (merge `80c5581`, 30/10/2026)

- La API solo acepta altas con `privacyPolicyVersion = lista-espera-v5`; v1–v4 responden 400 `WAITLIST_POLICY_VERSION_RETIRED`. v5 sin teléfono sigue en 400 `WAITLIST_PHONE_REQUIRED`; con teléfono, 202.
- Desaparece `WAITLIST_PHONE_NOT_INFORMED` (sin v2–v4 no tiene uso).
- Landing: ante `WAITLIST_POLICY_VERSION_RETIRED` (página antigua en caché) pide recargar y volver a enviar.
- Se aplica tras esperar al menos 48 h con la landing v5 publicada (publicada el 27/10), condición de la revisión de seguridad.
- Sin migraciones; las altas ya guardadas con v2–v4 no se modifican. Documentación al día: `docs/WAITLIST_API.md`, `docs/SECURITY_BASELINE.md` y el README de la landing.

## Seguridad

- **Multi-tenant:** mover cita filtra por `workspaceId` en la lectura y en la escritura; los tests cubren otro espacio.
- **Roles:** la recepción mueve citas pero no ve contenido clínico (la respuesta es la de `GET /sessions/:id` para su rol, sin notas); un terapeuta solo mueve sus citas y el intento sobre otra queda auditado.
- **Auditoría transaccional** del movimiento, del cierre de solicitudes y del aviso: si falla una parte, no se escribe nada.
- **Sin canal externo:** el aviso al paciente vive solo en el portal; no se ha añadido ningún envío de correo ni SMS.
- **Contraseñas por soporte:** el CLI invalida las sesiones abiertas (`tokenVersion` y refresh tokens) y no deja secretos en la auditoría ni en el historial de la terminal.
- **Revisión de seguridad (Argos):** aprobada en #51 (API y web) y #52, según su descripción; #50 incorpora sus condiciones en el commit `e892ad7`; #48 son pruebas pedidas en su revisión del Sprint 19. #48 y #50 no tienen descripción en el PR.
- Sin datos reales en código, tests ni seeds.

## Decisiones técnicas

- **Ruta propia `PATCH /sessions/:id/reschedule`** en lugar de ampliar el `PATCH` heredado: contrato estricto (solo dos campos, `forbidNonWhitelisted`) y errores con código estable para la web.
- **Mismo bloqueo que las solicitudes del portal**: evita que un movimiento y una aprobación ocupen el mismo hueco a la vez.
- **Cerrar las solicitudes pendientes de esa cita** en lugar de reubicarlas: la petición del paciente se refería a la hora antigua.
- **Aviso dentro del portal como notificación `SYSTEM` ya enviada**: reutiliza la bandeja existente sin migración y sin entrega externa.
- **CLI en lugar de pantalla** para restablecer contraseñas: el piloto demo es pequeño y así no se abre una superficie de recuperación de cuentas en la web.

## Evidencia

- **Cifras de tests (Quima, recogidas en la descripción del PR #51):** 1695 tests de seguridad con PostgreSQL real y 241 tests de web, build y prueba de punta a punta en verde. Para #48, #50 y #52 no se han aportado recuentos.
- **CI (consulta a la API pública de GitHub, 30/10/2026):** los dos checks (`Typecheck, tests and build` y `PostgreSQL migrations and real HTTP smoke test`) en verde en el último commit de cada PR (`b386d9e`, `f00db88`, `3587a8c`, `860a02d`) y en el merge `6493620`. En los merges `796a57a`, `cbba29a` y `80c5581` las ejecuciones aparecen canceladas (sustituidas por la del merge siguiente). En el merge final `4057655`, los dos checks en verde (segunda consulta del 30/10/2026).
- **Producción (solo `GET`, sin credenciales, 30/10/2026):** la web publicada de la agenda ya incluye «Cambiar fecha u hora» en su código. No se ha comprobado el `PATCH` en la API de producción ni el aviso en un portal real.

## Pendiente

- **Antes de la primera demostración con «Mover cita»:** hacer un movimiento real en el entorno demo (mover, ver la cita en la semana y el aviso en el portal del paciente).
- **Antes de la primera alta real del piloto demo:** los criterios del Sprint 19 siguen abiertos (P0 en producción, privacidad `demo-1.2` visible, capturas del manual).
- **Antes del primer paciente real:** riesgo M1 de `TRUST_PROXY`, revisión por abogado de los textos legales y el resto de la Fase B del roadmap.
- **Producto:** «Preparar sesión» abre la sesión que viene (vacía), no lo trabajado en la anterior; no hay recordatorios ni avisos fuera del portal; la lista «Tareas por revisar» con varios pacientes se limita a 5 entregas.

## Criterio de aprobación

La entrega queda **Implementada** en `main` con el CI en verde en `4057655`. Pasará a validada para el piloto demo cuando conste por escrito:

- en producción, una cita movida desde la agenda por el titular, el aviso «Tu cita ha cambiado» en el portal del paciente y un 403 al intentar mover la cita de otro profesional;
- una contraseña restablecida con `users:set-password` en una cuenta demo, con las sesiones anteriores cerradas;
- un alta en la lista de espera con una versión retirada respondiendo `WAITLIST_POLICY_VERSION_RETIRED`.
