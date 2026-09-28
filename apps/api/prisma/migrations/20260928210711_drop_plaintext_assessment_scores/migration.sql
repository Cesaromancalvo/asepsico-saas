-- Cifrado de las escalas, paso 2 de 2: elimina las columnas legado en claro de
-- ClinicalAssessment (totalScore, severity, riskFlag). Su contenido ya vive cifrado en `result`.
--
-- SOLO se despliega después de haber ejecutado en ese entorno, con la versión del paso 1:
--   npm run db:encrypt-fields            (copia el legado cifrado a `result` y lo vacía)
-- Guarda: si queda algún valor legado sin migrar, la migración ABORTA sin borrar nada
-- (migrate deploy falla y la transacción se revierte). Prisma la deja marcada como FALLIDA
-- en _prisma_migrations y no aplicará ninguna otra hasta resolverlo. En ese caso:
--   1. Con la versión del paso 1 desplegada: npm run db:encrypt-fields (y --dry-run hasta
--      ver pendientes=0).
--   2. npx prisma migrate resolve --rolled-back 20260928210711_drop_plaintext_assessment_scores
--   3. Volver a desplegar (migrate deploy la reintenta).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ClinicalAssessment"
    WHERE "totalScore" IS NOT NULL OR "severity" IS NOT NULL OR "riskFlag" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Quedan puntuaciones de escalas en claro sin migrar: ejecuta "npm run db:encrypt-fields" antes de esta migración';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "ClinicalAssessment" DROP COLUMN "riskFlag",
DROP COLUMN "severity",
DROP COLUMN "totalScore";
