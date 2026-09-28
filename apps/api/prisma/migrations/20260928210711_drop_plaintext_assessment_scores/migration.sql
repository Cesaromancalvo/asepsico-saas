-- Cifrado de las escalas, paso 2 de 2: elimina las columnas legado en claro de
-- ClinicalAssessment (totalScore, severity, riskFlag). Su contenido ya vive cifrado en `result`.
--
-- SOLO se despliega después de haber ejecutado en ese entorno, con la versión del paso 1:
--   npm run db:encrypt-fields            (copia el legado cifrado a `result` y lo vacía)
-- Guarda: si queda algún valor legado sin migrar, la migración ABORTA sin borrar nada
-- (migrate deploy falla y la transacción se revierte). En ese caso: ejecutar el script y
-- volver a desplegar.
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
