-- Cifrado de puntuación, gravedad y alerta de riesgo de las escalas (decisión del Jefe).
-- Paso 1 de 2, NO destructivo: añade la columna cifrada `result` y permite NULL en las columnas
-- en claro. La API deja de escribirlas; el script prisma/scripts/encrypt-plaintext-fields.ts
-- copia sus valores cifrados a `result` y las vacía. Una migración POSTERIOR (otro despliegue,
-- tras ejecutar el script) las eliminará con una guarda que aborta si queda algún valor.
-- SQL no puede cifrar: por eso la copia de datos no está aquí.

-- AlterTable
ALTER TABLE "ClinicalAssessment" ADD COLUMN     "result" TEXT,
ALTER COLUMN "totalScore" DROP NOT NULL,
ALTER COLUMN "severity" DROP NOT NULL,
ALTER COLUMN "riskFlag" DROP NOT NULL,
ALTER COLUMN "riskFlag" DROP DEFAULT;
