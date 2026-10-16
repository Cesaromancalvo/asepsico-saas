-- Hallazgo de Argos [MEDIA]: INVOICE_VOIDED y PAYMENT_REVERSED copiaban en "metadata.reason" el
-- texto libre del motivo. Incumple SECURITY_BASELINE ("AuditLog.metadata ... solo nombres de
-- campo e ids"), sobrevive al borrado del paciente y sale en la exportación del workspace.
-- El texto ya está en "Invoice"."voidReason" y "Payment"."reversalReason"; aquí solo se quita la
-- copia y se deja la marca "reasonProvided" (y "invoiceId" en facturas, como escribe la API).
--
-- Solo datos, sin cambio de esquema (prisma migrate diff sigue vacío).
-- Idempotente: tras ejecutarse ninguna fila conserva la clave "reason", así que el WHERE ya no
-- la selecciona. Las claves que ya existan en la fila tienen prioridad sobre las añadidas.
-- "metadata" es JSONB (migración init); se limita a objetos JSON para no alterar otros tipos.
UPDATE "AuditLog"
SET "metadata" = jsonb_build_object('invoiceId', "entityId", 'reasonProvided', true)
                 || ("metadata" - 'reason')
WHERE "action" = 'INVOICE_VOIDED'
  AND jsonb_typeof("metadata") = 'object'
  AND "metadata" ? 'reason';

UPDATE "AuditLog"
SET "metadata" = jsonb_build_object('reasonProvided', true) || ("metadata" - 'reason')
WHERE "action" = 'PAYMENT_REVERSED'
  AND jsonb_typeof("metadata") = 'object'
  AND "metadata" ? 'reason';
