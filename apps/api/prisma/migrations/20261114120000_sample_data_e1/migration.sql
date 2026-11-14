-- E1 · Espacio de prueba listo para mirar (14/11/2026). Solo columnas nuevas, sin tocar datos:
--  - RegistrationInvite.withSampleData: invitación del piloto demo con espacio de prueba cargado
--    (la pone el CLI del operador; las invitaciones existentes quedan en false).
--  - Workspace.sampleDataLoadedAt / sampleDataClearedAt: compare-and-set de la carga (idempotente)
--    y fecha del borrado por el titular. Los datos de ejemplo siguen marcados con Patient.isDemo.

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "sampleDataClearedAt" TIMESTAMP(3),
ADD COLUMN     "sampleDataLoadedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RegistrationInvite" ADD COLUMN     "withSampleData" BOOLEAN NOT NULL DEFAULT false;
