# Sprint 6 — Facturación y pagos

## Entregado
- Facturas en borrador, emisión y anulación con trazabilidad.
- Líneas de factura y cálculo de base, impuestos y total exclusivamente en backend.
- Cobros parciales o completos y saldo pendiente.
- Métodos de pago: efectivo, tarjeta, transferencia, Bizum, domiciliación y otros.
- Idempotencia opcional para impedir cobros duplicados.
- Reversión auditada de pagos sin borrado contable.
- Resumen económico: facturado, cobrado, pendiente y vencidas.
- Pantalla `/management` conectada a la API.

## Seguridad
- Acceso financiero para OWNER, ADMIN y ASSISTANT; THERAPIST queda bloqueado.
- Aislamiento obligatorio por workspace en facturas y pagos.
- Importes recalculados en servidor; el cliente no decide totales.
- Facturas emitidas son inmutables; solo borradores se editan.
- Facturas con pagos activos no pueden anularse.
- Registros financieros no se eliminan: se anulan o revierten.
- Auditoría sin incluir notas narrativas ni datos clínicos.

## Pruebas añadidas
`apps/api/test/billing.security-spec.ts` comprueba roles, multi-tenant, cálculo servidor, sobrepago, idempotencia, anulación y auditoría.
