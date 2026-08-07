# Sprint 6 — Facturación y pagos

## Objetivo
Incorporar una gestión económica sencilla, trazable y separada de la información clínica.

## Funcionalidades
- Panel de facturación en `/management`.
- Resumen de importes facturados, cobrados, pendientes y facturas vencidas.
- Facturas en borrador, emitidas, parcialmente pagadas, pagadas, anuladas y vencidas.
- Líneas de factura con cantidad, precio unitario e impuesto en puntos básicos.
- Cálculo de subtotales, impuestos y total exclusivamente en backend.
- Numeración correlativa por workspace.
- Registro de cobros en efectivo, tarjeta, transferencia, Bizum, domiciliación u otros.
- Pagos parciales y saldo pendiente.
- Reversión trazable de pagos.
- Claves de idempotencia para evitar cobros duplicados.
- Auditoría de creación, emisión, anulación, cobro y reversión.

## Seguridad
- Acceso económico permitido a OWNER, ADMIN y ASSISTANT.
- THERAPIST queda bloqueado para evitar exposición innecesaria de información financiera.
- Todas las consultas y mutaciones están limitadas por `workspaceId`.
- Las respuestas de facturación solo incluyen datos identificativos mínimos del paciente; no incluyen narrativa clínica.
- No se confía en importes calculados por el frontend.
- No se puede editar una factura emitida, anular una factura con pagos activos ni registrar un pago superior al saldo.
- La reutilización de una clave de idempotencia con datos distintos se rechaza.

## Endpoints
- `GET /billing/summary`
- `GET /billing/invoices`
- `GET /billing/invoices/:id`
- `POST /billing/invoices`
- `PATCH /billing/invoices/:id`
- `POST /billing/invoices/:id/issue`
- `POST /billing/invoices/:id/void`
- `POST /billing/payments`
- `POST /billing/payments/:id/reverse`

## Pruebas incluidas
`apps/api/test/billing.security-spec.ts` contiene pruebas de regresión sobre:
- bloqueo de terapeutas;
- acceso administrativo sin narrativa clínica;
- aislamiento entre workspaces;
- cálculo de importes en servidor;
- auditoría;
- rechazo de sobrepagos;
- idempotencia;
- rechazo de claves de idempotencia reutilizadas;
- bloqueo de anulación con pagos activos.

## Resultado de validación
La suite automatizada de seguridad e integración se ejecutó en el entorno de trabajo: **25 pruebas superadas de 25, distribuidas en 5 suites**. Incluye las pruebas específicas de facturación y las regresiones de seguridad anteriores.

El `typecheck` completo no quedó validado porque el Prisma Client disponible estaba generado contra un esquema anterior. Debe regenerarse localmente antes del typecheck:

```bash
npm install
npm run db:generate
npm run db:migrate
npm run typecheck
npm --workspace @asepsico/api run test:security
npm run dev:api
npm run dev:web
```
