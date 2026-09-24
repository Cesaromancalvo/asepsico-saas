-- Estado de "bloqueado" (art. 32 LOPDGDD): cuando se solicita la baja/borrado de un
-- paciente pero existe obligacion legal de conservar la historia clinica (Ley 41/2002,
-- minimo 5 anos), los datos no se borran de inmediato: se bloquean, quedando fuera de
-- cualquier uso normal, accesibles solo para defensa legal, hasta que expire el plazo.
ALTER TYPE "PatientStatus" ADD VALUE 'BLOCKED';

ALTER TABLE "Patient" ADD COLUMN "blockedAt" TIMESTAMP(3);
ALTER TABLE "Patient" ADD COLUMN "retentionUntil" TIMESTAMP(3);
