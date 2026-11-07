-- Argos M3 (07/11/2026): las entregas EMAIL sin plantilla (las creaba facturación con importes cuando
-- el paciente tenía emailEnabled) no se envían nunca. Se cierran para que no queden PENDING para
-- siempre. Solo datos; no cambia el esquema. Facturación ya solo crea IN_APP.
UPDATE "NotificationDelivery"
SET "status" = 'CANCELLED', "errorCode" = 'NO_TEMPLATE', "claimToken" = NULL, "claimedUntil" = NULL
WHERE "channel" = 'EMAIL' AND "template" IS NULL AND "status" = 'PENDING';
