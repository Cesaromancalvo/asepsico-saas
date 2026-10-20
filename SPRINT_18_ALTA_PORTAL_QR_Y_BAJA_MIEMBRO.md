# Sprint 18 — Alta en el portal con QR y baja de miembros del equipo (entrega S5, 20/10/2026)

## Objetivo

Dos piezas que una consulta necesita antes del piloto:

1. **Alta del paciente en el portal con el QR fijo de cada profesional**: el paciente pide acceso desde su móvil, la consulta revisa la solicitud y le entrega en persona el enlace para activar su cuenta.
2. **Baja de un miembro del equipo**: cuando un profesional deja la consulta, su sesión se corta al momento, su trabajo pasa a otro profesional (o se decide después) y sus notas internas no pasan a nadie.

Este documento registra lo que hay en la rama `feat/s5-integracion` + `feat/s5-web` (HEAD `9e08ba1`). **La entrega aún no está desplegada ni fusionada en `main`.** No declara nada como validado para datos clínicos reales: los textos legales del alta son un borrador pendiente de abogado y faltan los datos públicos del responsable.

Numeración: la entrega S4 (sesión 4, PR #28) no tiene documento propio y ocupa el número 17 en el roadmap; esta entrega S5 toma el siguiente número libre, **18**.

## Qué incluye

### API (`apps/api`)

**Alta en el portal por QR (`src/portal-signup/`)**

- **QR fijo por profesional** (`PortalIntakeLink`): token aleatorio de 256 bits, guardado como hash SHA-256 y cifrado. `GET/POST rotate/DELETE /portal-intake-links/:professionalId` (`me` para el propio). Solo lo gestiona quien puede gestionarlo; `ASSISTANT` no imprime ni rota QR ajenos. Al dar de baja al profesional, su QR deja de funcionar.
- **Envío público** `POST /api/v1/public/portal-signup/requests` (202): respuesta **idéntica** con token válido, inválido, rotado, desactivado o solicitud descartada por límites, para no permitir enumerar profesionales ni consultas. Límites: 10 envíos por IP y hora, 10 solicitudes por QR y hora y 20 pendientes por profesional (lo que sobra se descarta en silencio y se audita sin datos personales). Cuerpo limitado a 16 KB.
- **Edad mínima 18** para el alta con QR (`MIN_SIGNUP_AGE_YEARS`, 400 `PORTAL_SIGNUP_MIN_AGE`). Los menores y los pacientes sin fecha de nacimiento solo se activan **manualmente en persona** (400 `PORTAL_SIGNUP_MANUAL_IN_PERSON` al vincular).
- **Solicitud pendiente cifrada** (`PortalSignupRequest`): no da acceso a nada. Solo existe mientras está pendiente; aceptarla, rechazarla o que caduque la **borra** y queda solo la auditoría (ids, sin datos personales).
- **Bandeja «Altas del portal»** (`GET /portal-signup-requests`): el profesional destinatario ve las suyas; `OWNER`, `ADMIN` y `ASSISTANT`, todas las del espacio (acto administrativo: la recepción comprueba la identidad en persona).
- **Resolver**: vincular a una ficha existente (`:requestId/link`), crear paciente (`:requestId/create-patient`), rechazar (`:requestId/reject`) o rechazo masivo (`bulk-reject`). Al vincular, las diferencias de correo o teléfono con la ficha y un portal desactivado antes exigen confirmación explícita: sin ella, **409 `PORTAL_SIGNUP_CONFIRMATION_REQUIRED`** con la lista de avisos; con ella (`confirmWarnings`), la confirmación queda auditada. Otros 409: `PORTAL_SIGNUP_IDENTITY_MISMATCH`, `PORTAL_ACCOUNT_ALREADY_EXISTS`.
- **Activación**: al aceptar se crea la cuenta del portal **inactiva** (`pendingActivation`) y un enlace de activación de un solo uso con **72 h** de vida, que se devuelve una vez a la consulta y se entrega al paciente **solo en persona** (nunca por correo). `POST /api/v1/public/portal-signup/activate` (10 por IP y hora) pone la contraseña y activa la cuenta. Reemisión del enlace: `POST /patients/:patientId/portal-account/activation-link` (revoca el anterior). La activación manual anula la cuenta pendiente del alta por QR.
- **Correo sin verificar** (`emailVerifiedAt`): un correo sin verificar de una cuenta ya desactivada puede liberarse (`release-email`, `OWNER`/`ADMIN`, auditado).
- **Caducidad a 14 días con purga automática** dentro de la API (`PortalSignupCleanupService`): unos 10 s tras arrancar y después **cada hora**, en todos los espacios, idempotente, sin datos en los logs. Respaldo manual: `npm run portal-signup:purge` (ver `ops/PILOT_RUNBOOK.md`).
- **Textos legales**: la API solo conoce las versiones vigentes (`portal-alta-qr-art13-v1.0-borrador-2026-10-20` y `portal-normas-uso-v1.0-borrador-2026-10-20`), que el paciente reconoce y quedan guardadas en la cuenta. Son **borradores pendientes de abogado**.

**Baja de miembros (`src/workspace-members/`, `src/common/auth/active-session.ts`)**

- `GET /workspace-members/:userId/removal-preview` y `POST /workspace-members/:userId/remove` (`OWNER`/`ADMIN`; `ADMIN` solo sobre `THERAPIST`/`ASSISTANT`; nadie a sí mismo ni al último `OWNER`). La membresía pasa a **`REMOVED`** con fecha, autor y motivo de lista cerrada; no se borran ni la fila ni el `User`, así que autoría y auditoría se conservan.
- **Corte inmediato de la sesión**: cada petición revalida contra la base de datos que la membresía siga `ACTIVE` y que el `tokenVersion` del token coincida con el del usuario; si no, **401 `SESSION_REVOKED`**. También suben `tokenVersion` el cambio de contraseña y la desactivación del MFA, lo que cierra la ventana de 15 minutos que quedó como limitación en el Sprint 16.
- En la misma transacción: revoca sus refresh tokens del espacio, cierra sus accesos excepcionales, rechaza sus solicitudes de cita pendientes, apaga su reserva desde el portal y audita `MEMBER_REMOVED` con recuentos.
- **Reasignación** de procesos `ACTIVE`/`PAUSED` y citas futuras a otro profesional clínico activo, en la baja o después (`POST :userId/reassign`), con 409 `REASSIGN_SCHEDULE_CONFLICT` o `REASSIGN_PROCESS_CONFLICT` si choca. Opción **«decidir después»**: mientras tanto, los avisos y recordatorios dirigidos al profesional dado de baja van a los `OWNER`/`ADMIN` activos.
- **Notas internas del profesional anterior**: al reasignar un proceso, sus `internalNotes` pasan cifradas, con su autor, a `ClinicalProcessPrivateNote`, y el campo vivo queda vacío para el nuevo profesional, que solo ve el indicador `hasPreviousAuthorNotes` (art. 18.3 Ley 41/2002). **Hoy no tienen ninguna vía de lectura**: la exportación del espacio solo da el recuento `archivedPrivateNotes`.
- La lectura de un proceso ajeno por un co-terapeuta queda auditada (`CLINICAL_PROCESS_READ_NOT_AUTHOR`).

**Contratos (`packages/contracts`)**: tipos del alta por QR y códigos `REASSIGN_PROCESS_CONFLICT` y `BOOKING_UNAVAILABLE`.

### Web (`apps/web`)

- **Ajustes > QR del portal** (`/settings/portal-qr`): QR del profesional, cartel imprimible sin datos de la consulta, rotar y desactivar, y aviso de solicitudes falsas junto al enlace. Generado en el navegador con `qrcode-generator` 1.4.4.
- **Alta pública** (`/portal/alta`, `/portal/alta/informacion`, `/portal/alta/normas`): formulario con la información art. 13 en capa 1 y las normas de uso (v1.0 borrador). El token se lee del fragmento de la URL y se borra de ella al leerlo. Los datos del responsable que aún no sirve la API se muestran como marcador visible (`[Datos de la consulta pendientes]`).
- **Activación** (`/portal/activar`).
- **Bandeja «Altas del portal»** (`/portal-signups`) con contador en la navegación, tarjetas de solicitud, diálogo de vinculación con confirmación de avisos y entrega del enlace de activación en persona.
- **Ajustes > Equipo**: diálogo de baja con resumen previo, motivo, reasignación o «decidir después».
- Aviso en la ficha del proceso cuando hay notas del profesional anterior.
- **Manejo global de `SESSION_REVOKED`**: si renovar la sesión no es posible, la web vuelve a `/login?sesion=terminada`.
- **Cabeceras** `Referrer-Policy: no-referrer` y `X-Robots-Tag: noindex, nofollow` en `/portal/alta` y `/portal/activar`.

### Migraciones (aditivas)

| Migración | Contenido |
|---|---|
| `20261021090000_alta_portal_qr_profesional` | `PortalIntakeLink`, `PortalSignupRequest`, `PortalActivationToken`; columnas de activación pendiente y versiones de textos en `PatientPortalAccount` (CHECK: una cuenta no puede estar pendiente y activa) |
| `20261021091000_portal_email_sin_verificar` | `PatientPortalAccount.emailVerifiedAt` |
| `20261022090000_baja_miembro_y_token_version` | Enums `WorkspaceMemberStatus` y `MemberRemovalReason`; `User.tokenVersion` y `passwordChangedAt`; estado y datos de baja en `WorkspaceMember` |
| `20261023090000_notas_internas_profesional_anterior` | `ClinicalProcessPrivateNote` |

Con ellas el repositorio pasa de **33 a 37 migraciones**. Ninguna borra ni modifica datos existentes.

### Operación

- `ops/PILOT_RUNBOOK.md`: purga automática de solicitudes y respaldo manual; notas internas archivadas sin vía de lectura.
- `docs/SECURITY_BASELINE.md`: revalidación del token, `tokenVersion`, baja de miembros y notas archivadas (equipo), y un apartado resumido del alta por QR (añadido con este documento).

## Seguridad

- **Argos: aprobado**, con sus condiciones aplicadas en la propia rama. Entre ellas: el token del alta sale de la URL al leerlo (`f437798`), el QR de un profesional dado de baja deja de funcionar (`37de738`), los avisos de un profesional dado de baja sin reasignar van a `OWNER`/`ADMIN` (`addcdef`), la reasignación solo mueve citas sin resumen interno del que se va (`0499d01`), las notas internas se archivan con su autor y el destino empieza vacío (`c55a9b5`) y las notas archivadas no salen en la exportación del espacio (`0af93e8`). Las condiciones del alta por QR tienen su propia suite (`portal-signup-argos.security-spec.ts`).
- La API no envía correos. Los correos de las cuentas del portal nacen sin verificar y `no-email-sending.security-spec.ts` falla si aparece código de envío que no pase por la comprobación de correo verificado. El enlace de activación se entrega en persona.
- Multi-tenant: todas las consultas del alta y de la baja filtran por `workspaceId`; el envío público no revela si el QR existe.
- Sin datos personales en la auditoría ni en los logs: solo ids, recuentos y motivos de lista cerrada.
- Sin datos reales: los tests usan datos ficticios.

## Decisiones técnicas

- **Un QR fijo por profesional** (rediseño del 18/10), impreso en la consulta, en lugar de un QR por paciente.
- **Edad mínima 18** con el QR (decisión del Jefe del 20/10, siguiendo la recomendación legal interna): de 16 a 17 años, alta manual en persona hasta que responda el abogado. El valor vive en un solo sitio de la API; ningún texto ni test lo lleva escrito a mano.
- **Purga dentro de la API** y no en GitHub Actions: el repositorio es público y no debe guardar `DATABASE_URL` de producción.
- **Baja sin borrado**: estado `REMOVED` para conservar autoría y auditoría.
- **Notas internas archivadas sin lectura** hasta que exista la exportación clínica completa (H1).
- Las specs de producto de Vega de esta entrega no se suben al repositorio público: mezclan detalles de proveedores, costes y textos legales que viven fuera del repo.

## Evidencia y cifras

Verificación de Quima sobre la rama de la entrega:

- `test:security` con PostgreSQL real: **1448/1448**.
- Tests de la web: **136/136**.
- Smoke HTTP y scripts de verificación en vivo del CI: **en verde**.
- Prueba manual por HTTP: **21/21**.
- Revisión de Argos: **aprobado** (condiciones aplicadas).

No se ha ejecutado aún en el entorno desplegado: la entrega está **lista para desplegar**.

## Pendiente

**Antes de usar el alta por QR con pacientes reales**

- **H1 — datos públicos del responsable**: endpoint público que sirva los datos de la consulta para rellenar los marcadores de la pantalla de alta. Hoy se ven como `[Datos de la consulta pendientes]`.
- **Revisión por abogado** de los textos v1.0 (información art. 13 y normas de uso del portal), hoy en borrador.

**Antes de que un cliente real se dé de baja o pida la devolución de sus datos**

- **H1 — exportación clínica completa**: debe incluir las notas internas vivas y las archivadas (`ClinicalProcessPrivateNote`) con su autor, solo para el `OWNER` con reautenticación, auditada por proceso y excluida siempre de la exportación del paciente y de la de un `THERAPIST`.

**Producto (Vega, con revisión legal)**

- Lectura de las notas archivadas por **acceso excepcional**: sin decidir.
- **Reincorporación** de un miembro dado de baja: no existe todavía.
- Con «decidir después», las citas futuras del profesional dado de baja **siguen enviando el aviso «Próxima cita»** al paciente: pendiente de decisión.

## Criterio de aprobación

La entrega S5 se considera **desplegada** cuando:

- la PR de S5 está fusionada en `main` con los checks `quality` y `postgres-integration` en verde;
- las 4 migraciones están aplicadas en producción (37 en total) con copia previa;
- se comprueba en el entorno, sin datos reales, el alta por QR de principio a fin y la baja de un miembro con su `SESSION_REVOKED`.

Estado actual: **Implementado, Pruebas incluidas, Ejecución confirmada en rama**. No es **Validado** para pacientes reales hasta cerrar los pendientes de H1 y del abogado.
