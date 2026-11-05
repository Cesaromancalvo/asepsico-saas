-- Política lista-espera-v6: preferencia de contacto de la lista de espera.

-- CreateEnum
CREATE TYPE "WaitlistContactPreference" AS ENUM ('PHONE_AND_EMAIL', 'EMAIL_ONLY');

-- AlterTable
ALTER TABLE "WaitlistEntry" ADD COLUMN     "contactPreference" "WaitlistContactPreference";

-- Datos (Lex Psi, revisión 03/11/2026 §1.4): las filas ACTIVAS anteriores a la v6 reciben la preferencia
-- que consintieron. Con teléfono (altas v5, o v2–v4 con teléfono añadido con waitlist:set-phone) →
-- PHONE_AND_EMAIL; sin teléfono (altas v2–v4, o v5 a las que ya se borró el teléfono porque no
-- querían llamadas) → EMAIL_ONLY. Las filas suprimidas se quedan en NULL (no conservan nada).
-- No toca privacyPolicyVersion ni ningún otro campo.
UPDATE "WaitlistEntry"
SET "contactPreference" = CASE WHEN "phone" IS NOT NULL THEN 'PHONE_AND_EMAIL'::"WaitlistContactPreference" ELSE 'EMAIL_ONLY'::"WaitlistContactPreference" END
WHERE "deletedAt" IS NULL;
