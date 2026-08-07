# Correcciones de usabilidad y core clínico

## Problemas corregidos

1. **Pacientes y procesos**
   - La sección ya no utiliza una navegación aislada.
   - Se integra en el layout principal con la barra lateral.
   - Se mantiene siempre una salida clara hacia Inicio, Seguimiento, Agenda y Gestión.
   - El nombre de menú `Procesos` se sustituye por `Pacientes` para evitar ambigüedad.

2. **Seguimiento terapéutico**
   - Nueva ruta profesional `/follow-up`.
   - Muestra todos los pacientes activos y permite entrar directamente a plan y evolución, tareas, escalas, sesiones y ficha clínica.
   - La línea temporal reconoce ahora escalas, documentos, consentimientos e informes, además de sesiones, objetivos, tareas e historia.

3. **Facturación**
   - Nuevo endpoint `POST /billing/invoices/:id/send`.
   - Solo permite compartir facturas emitidas, pagadas, parciales o vencidas; nunca borradores ni anuladas.
   - Publica la factura en el portal del paciente y crea la notificación correspondiente.
   - Si el paciente tiene correo y el canal email activado, crea también la entrega pendiente para el proveedor de correo.
   - Registra auditoría `INVOICE_SENT_TO_PATIENT`.
   - La interfaz muestra el flujo correcto: crear borrador -> emitir -> enviar al paciente.

## Verificación

- Typecheck del frontend: correcto.
- Suite de seguridad e integración: 8 suites, 41 pruebas superadas, 0 fallos.
- Se añadieron pruebas para envío de facturas y bloqueo de facturas en borrador.

## Nota de correo real

El envío dentro del portal funciona con la infraestructura actual. La entrega real por correo queda en estado `PENDING` hasta conectar un proveedor como Resend, SendGrid o equivalente.
