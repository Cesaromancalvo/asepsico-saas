-- Límite de intentos de segundo factor por cuenta: fallos seguidos y espera temporal
-- creciente (nunca bloqueo permanente). Se ponen a 0 / NULL con cualquier verificación
-- correcta.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mfaFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfaLockedUntil" TIMESTAMP(3);
