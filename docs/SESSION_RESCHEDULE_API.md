# «Mover cita»: contrato de la API para la agenda

Implementación en `apps/api/src/sessions/` (`SessionsService.reschedule`, `session-reschedule.util.ts`);
tipos en `packages/contracts/src/session-reschedule.ts`; tests en
`apps/api/test/session-reschedule.security-spec.ts`.

## Petición

```
PATCH /api/v1/sessions/:id/reschedule
Content-Type: application/json   (cookie de sesión + cabecera CSRF, como el resto de la agenda)

{ "startsAt": "2026-11-03T19:30:00+01:00", "endsAt": "2026-11-03T20:20:00+01:00" }
```

- Los dos campos son obligatorios. Cambiar solo la duración = mismo `startsAt`, otro `endsAt`.
- Instantes ISO 8601 **con zona** (`Z` o `±hh:mm`). La web convierte la hora local del espacio
  (`Workspace.timeZone`, por defecto `Europe/Madrid`) a instante. Sin zona → 400 de validación.
- Campos de más (p. ej. `notes`) → 400 de validación (`forbidNonWhitelisted`).
- Respuesta 200: el detalle de la sesión, igual que `GET /sessions/:id` para ese rol (ASSISTANT,
  sin notas ni título del proceso).

`PATCH /sessions/:id` sigue existiendo (heredado, admite además `notes`) con las mismas reglas; la web
no lo usa. Sin `startsAt` ni `endsAt` (cuerpo vacío o solo notas) → 400 `NO_CHANGE`, sin auditoría
ni aviso; las notas se editan con `PATCH /sessions/:id/notes`.

## Permisos

| Rol | Puede mover |
|---|---|
| OWNER, ADMIN | cualquier cita del espacio |
| ASSISTANT | cualquier cita del espacio (ya creaba y cancelaba citas) |
| THERAPIST | solo sus citas; la de otro → 403 `NOT_OWN_SESSION`, auditado como `CLINICAL_ACCESS_DENIED` |

Todo filtrado por `workspaceId`: una cita de otro espacio es 404 `SESSION_NOT_FOUND`.

## Errores (`code` en el cuerpo)

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `INVALID_RANGE` | fin <= inicio, fecha no válida o más de 12 h |
| 400 | `START_IN_PAST` | la hora nueva ya ha pasado |
| 400 | `NO_CHANGE` | la hora nueva es la misma que la actual, o no se indica hora (PATCH heredado) |
| 400 | `SESSION_OVERLAP` | el profesional ya tiene otra cita no cancelada que se solapa |
| 400 | `PROCESS_NOT_ACTIVE` | el proceso clínico de la cita ya no está activo |
| 403 | `NOT_OWN_SESSION` | THERAPIST con la cita de otro profesional |
| 404 | `SESSION_NOT_FOUND` | no existe en este espacio |
| 409 | `SESSION_NOT_SCHEDULED` | la cita está realizada, con ausencia o cancelada |
| 409 | `SESSION_ALREADY_STARTED` | la cita ya ha empezado o es pasada |
| 409 | `SLOT_NOT_AVAILABLE` | hay una solicitud del portal de otro paciente pendiente en esa franja: aprobarla o rechazarla antes |

Los errores de validación del DTO (400) no llevan `code`: traen `message` como lista.

## Reglas

- Mismo lock de agenda por profesional que el alta, la aprobación de solicitudes del portal y los
  bloqueos (`schedule-lock.util.ts`): comprobación de solapes y escritura atómicas.
- Las franjas de disponibilidad y los bloqueos solo limitan lo que se ofrece en el portal; desde la
  agenda se puede mover una cita fuera de ellos, igual que al crearla.
- Auditoría `SESSION_RESCHEDULED` en la misma transacción: `from`/`to` (inicio y fin), paciente,
  profesional, `source: "AGENDA"` y las solicitudes rechazadas. Nunca notas ni contenido clínico.
- **Solicitudes del portal pendientes sobre esa cita** (pedir otro día u hora, o cancelar): se
  rechazan en la misma transacción con motivo `CONTACT_PRACTICE` («contacta con la consulta»), porque
  se referían a la hora antigua. El hueco que retenía una petición de cambio se libera, cada rechazo
  se audita (`APPOINTMENT_REQUEST_REJECTED`, `cause: SESSION_RESCHEDULED_BY_STAFF`) y el paciente
  recibe el aviso genérico del portal (sin fecha, hora ni nombre). Si el movimiento falla, siguen
  pendientes.
- **Aviso dentro del portal** al paciente, en la misma transacción: «Tu cita ha cambiado: nueva
  fecha martes, 12 de enero, 19:30» (día y hora en la zona del espacio). Va por `patientId`, así
  que lo ven las cuentas activas de ese paciente (él o su tutor) en `GET /portal/notifications`. Sin
  profesional, proceso, tipo de sesión ni ningún dato clínico. Tipo `SYSTEM`, sin migración.
- No se envía correo ni SMS (no se crea ningún `NotificationDelivery`). El paciente ve también la
  hora nueva en las próximas citas de su portal.
