# Sprint 11 — Mensajería estructurada

## Objetivo funcional
Ofrecer un canal asíncrono y acotado entre profesional y paciente, integrado con la ficha y el portal, sin presentarlo como chat de urgencias ni como disponibilidad clínica permanente.

## Capacidades incluidas
- Una conversación por relación profesional-paciente y workspace.
- Bandeja profesional con búsqueda, último mensaje y contador real de mensajes no leídos.
- Lectura automática al abrir la conversación.
- Envío profesional y respuesta del paciente desde el portal.
- Avisos internos sin contenido clínico: «Tienes un nuevo mensaje».
- Apertura directa desde la ficha mediante `patientId`.
- Permitir o bloquear respuestas del paciente.
- Cerrar, reabrir y archivar conservando trazabilidad.
- Acceso directo desde la conversación a la ficha del paciente.
- Auditoría de mensajes y cambios de estado.
- Aislamiento por workspace y validación de asignación para terapeutas.

## Límites de seguridad y producto
- El canal informa expresamente de que no sirve para urgencias.
- Las notificaciones externas no incluyen el cuerpo del mensaje.
- Los adjuntos solo aceptan metadatos completos y tipos PDF/JPEG/PNG.
- La subida binaria, antivirus, límite de tamaño y URL temporal deben conectarse a almacenamiento privado antes del piloto; no se simulan como resueltos.
- El personal administrativo no accede a conversaciones clínicas.

## Flujos críticos
1. El profesional abre la ficha o Mensajes, crea/recupera la conversación y envía un mensaje.
2. El paciente recibe un aviso genérico, entra en el portal y lo lee.
3. Si puede responder, envía un mensaje; el terapeuta asignado recibe un aviso genérico.
4. El profesional abre el hilo, el contador no leído se pone a cero y puede cerrar o archivar la conversación.
