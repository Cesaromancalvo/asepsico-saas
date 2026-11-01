# Avisos del personal dentro de la app: contrato de la API

Implementación en `apps/api/src/notifications/` (`NotificationsService`,
`appointment-change-notice.util.ts`); tipos en `packages/contracts/src/staff-notifications.ts`; tests en
`apps/api/test/appointment-change-notices.security-spec.ts` y `appointment-change-notices-db.security-spec.ts`
(PostgreSQL real).

**Solo dentro de la app.** Nunca se envía correo ni SMS (no se crea ningún `NotificationDelivery`).
Sin migración: usa el modelo `Notification` que ya existía (audiencia `PROFESSIONAL`).

## Endpoints

Cookie de sesión; las escrituras llevan además la cabecera CSRF, como el resto de la app.

| Método y ruta | Respuesta | Rol |
|---|---|---|
| `GET /api/v1/notifications?unreadOnly=true` | `StaffNotification[]` (máx. 100, más recientes primero) | cualquier miembro: solo los suyos |
| `GET /api/v1/notifications/unread-count` | `{ "unread": 3 }` | ídem |
| `PATCH /api/v1/notifications/:id/read` | `{ "ok": true }`; 404 si no es suyo o es de otro espacio | ídem |
| `POST /api/v1/notifications/read-all` | `{ "ok": true, "updated": 2 }` | ídem |

`GET /notifications` y `PATCH /notifications/:id/read` ya existían; `unread-count` y `read-all` son nuevos.
Todo va filtrado por `workspaceId` **y** `userId` del token, también al marcar como leído.

## Forma de un aviso

```json
{
  "id": "…", "type": "SYSTEM", "title": "Cita movida",
  "body": "Se ha movido tu cita con Paciente Uno: de martes, 10 de noviembre, 10:00 a jueves, 12 de noviembre, 19:30.",
  "actionUrl": "/agenda", "status": "SENT", "readAt": null,
  "scheduledAt": "…", "sentAt": "…", "createdAt": "…",
  "appointmentChange": {
    "change": "RESCHEDULED_BY_STAFF", "requestType": null,
    "patient": { "id": "…", "firstName": "Paciente", "lastName": "Uno" },
    "sessionId": "…", "requestId": null,
    "from": { "startsAt": "2026-11-10T09:00:00.000Z", "endsAt": "…" },
    "to":   { "startsAt": "2026-11-12T18:30:00.000Z", "endsAt": "…" }
  }
}
```

- `body` ya viene listo para mostrar (fechas en la zona del espacio). La campana puede pintar solo
  `title` y `body`, como con los demás avisos.
- `appointmentChange` es `null` en los avisos que no son de cambio de cita. Sirve para iconos, filtros
  o el enlace a la cita (`sessionId`) o a la solicitud (`requestId`).
- Si el lector no puede ver esa cita, o el paciente ya no existe: `patient`, `from`, `to`,
  `sessionId` y `requestId` vienen a `null` y `body` es el texto genérico.

## Cuándo se crea cada aviso

| Caso | `change` | Quién lo recibe |
|---|---|---|
| El profesional mueve o cancela su propia cita | (ninguno) | nadie del personal; el paciente recibe el suyo en el portal |
| Recepción, OWNER o ADMIN mueven la cita (`PATCH /sessions/:id/reschedule` o el heredado) | `RESCHEDULED_BY_STAFF` | el profesional de la cita |
| Recepción, OWNER o ADMIN la cancelan (`PATCH /sessions/:id/close` con `CANCELLED`) | `CANCELLED_BY_STAFF` | el profesional de la cita |
| El paciente pide en el portal cambiar la cita | `PATIENT_REQUESTED_RESCHEDULE` | el profesional + OWNER, ADMIN y recepción activos |
| El paciente pide en el portal cancelarla | `PATIENT_REQUESTED_CANCEL` | ídem |
| El paciente retira esa petición | `PATIENT_WITHDREW_REQUEST` | ídem |
| Otra persona aprueba una solicitud del portal | `REQUEST_APPROVED` | el profesional |
| Otra persona la rechaza | `REQUEST_REJECTED` | el profesional |

- Nunca se avisa a quien hace el cambio.
- Si el profesional ya no es miembro activo (baja con «decidir después»), su aviso va a los OWNER y
  ADMIN activos, como el resto de avisos (`routeToActiveMembers`).
- Una **cita nueva** pedida desde el portal sigue con su aviso genérico de siempre, solo al
  profesional («Nueva solicitud de cita»), sin `appointmentChange`.
- Los rechazos automáticos (caducidad, cierre del proceso, baja del profesional, hueco ocupado por
  otra aprobación) no generan aviso al personal.

## Qué se guarda y qué no

- `title`/`body` guardados: texto **genérico**, sin nombre del paciente, fecha ni hora (se mantiene el
  criterio 26 de la reserva desde el portal: es el texto que algún día podría viajar por correo).
- `patientId` (columna) y `metadata.appointmentChange`: tipo de cambio, ids de cita y solicitud, id del
  profesional e instantes de antes y después. **Nunca** el nombre, ni notas, proceso, tipo de sesión,
  modalidad o motivo de consulta.
- El nombre y las fechas legibles se componen **al leer**, con el acceso de agenda del lector:
  OWNER, ADMIN y recepción ven las del espacio (solo datos de agenda); un THERAPIST solo las de sus
  citas. El paciente se busca por id **y** `workspaceId`, y sin borrar.
- La respuesta es una lista blanca de campos: nunca `metadata`, `patientId`, `userId` ni `dedupeKey`.

## Envíos externos futuros (correo): regla obligatoria (condición M1 de Argos)

Si algún día estos avisos se envían fuera de la app (correo, SMS, push), el envío **solo** puede usar el
`title` y el `body` **guardados** en `Notification`, que son genéricos. **Nunca** `metadata`, ni el texto
enriquecido que compone `enrichAppointmentChanges` para `GET /notifications`, ni `appointmentChange`.
Lo bloquea el test «M1» de `appointment-change-notices.security-spec.ts`: para los 7 tipos de cambio,
no se crea ningún `NotificationDelivery` y el texto guardado no lleva nombre, iniciales ni horas.

## Supresión y retención (condición M2 de Argos)

- Los avisos del personal llevan `patientId` y deben borrarse con el paciente (por `patientId` **y**
  `workspaceId`). Hoy **no existe** un flujo de supresión o purga del paciente: archivar solo marca
  `deletedAt`, y mientras tanto el nombre ya no se muestra (la lectura busca el paciente sin borrar).
  **Pendiente:** cuando se cree la supresión o purga del paciente, debe incluir
  `notification.deleteMany({ where: { workspaceId, patientId } })` en su transacción.
- **Retención propuesta: 90 días** para los avisos del personal (leídos o no), aplicada con un job
  periódico en otra rama. Todavía no está implementado.
- Importación de pacientes (B1): un paciente importado con avisos ya **no se puede deshacer**
  (`patient-import-revert.service.ts` cuenta los `Notification` con su `patientId`). Mover o cancelar
  su cita desde la agenda, o que pida un cambio en el portal, le crea avisos. Ver
  `docs/producto/importacion-pacientes-csv.md`.
