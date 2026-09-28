-- PENDIENTE DE DECISIÓN DEL JEFE (commit aparte: se puede retirar sin afectar al resto).
--
-- Hasta el cifrado de escalas, la auditoría CLINICAL_ASSESSMENT_CREATED copiaba en claro la
-- puntuación, la gravedad y la alerta de riesgo en "metadata". La API ya no las escribe; esto
-- redacta las filas antiguas: quita esas tres claves y deja constancia con "scoresRedactedAt".
-- El resto del registro (quién, cuándo, qué escala, qué paciente) se conserva intacto.
--
-- Solo datos, sin cambio de esquema (prisma migrate diff sigue vacío).
-- Idempotente: tras ejecutarse, ninguna fila conserva esas claves, así que el WHERE ya no la
-- selecciona y "scoresRedactedAt" no se vuelve a tocar.
-- "metadata" es JSONB (migración init); se limita a objetos JSON para no alterar otros tipos.
UPDATE "AuditLog"
SET "metadata" = ("metadata" - 'totalScore' - 'severity' - 'riskFlag')
                 || jsonb_build_object('scoresRedactedAt', now()::text)
WHERE "action" = 'CLINICAL_ASSESSMENT_CREATED'
  AND jsonb_typeof("metadata") = 'object'
  AND "metadata" ?| array['totalScore', 'severity', 'riskFlag'];
