# Sprint 8 — Notificaciones y recordatorios

## Entregado
- Bandeja de avisos para profesionales y pacientes.
- Preferencias por usuario/paciente y canal.
- Recordatorios de citas, tareas, consentimientos y facturas.
- Generación idempotente mediante `dedupeKey`.
- Marcado de lectura con aislamiento por workspace e identidad.
- Registro de auditoría de cada lote procesado.
- Preparación de canales IN_APP, EMAIL y SMS mediante outbox de entregas.

## Decisiones de seguridad
- Los mensajes no contienen notas clínicas, diagnósticos ni resultados de escalas.
- Solo OWNER y ADMIN pueden lanzar manualmente el procesamiento.
- El portal valida que la cuenta siga activa.
- SMS se desactiva si el paciente no tiene teléfono registrado.
- Las consultas se filtran simultáneamente por workspace y destinatario.

## Operación
En producción, `POST /notifications/process-due` debe invocarse desde un job autenticado o sustituirse por un worker programado. Los proveedores externos de email/SMS quedan desacoplados para un sprint de infraestructura.
