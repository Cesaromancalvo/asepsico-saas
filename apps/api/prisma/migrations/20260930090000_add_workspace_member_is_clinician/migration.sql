-- Atributo clínico del miembro (acceso clínico por proceso activo).
-- isClinician por sí solo no da acceso a ningún paciente: el contenido clínico exige además un
-- proceso ACTIVO con el paciente (o ser autor de un proceso cerrado, solo para lo suyo).

-- AlterTable
ALTER TABLE "WorkspaceMember" ADD COLUMN     "isClinician" BOOLEAN NOT NULL DEFAULT false;

-- Valores iniciales para los miembros existentes:
--  - THERAPIST: clínico.
--  - OWNER: clínico (el titular de una consulta de una sola persona es quien atiende; no nota cambios).
--  - ADMIN: clínico solo si ya es profesional responsable de algún proceso clínico del workspace.
--  - ASSISTANT: nunca clínico.
UPDATE "WorkspaceMember" SET "isClinician" = true WHERE "role" IN ('THERAPIST', 'OWNER');

UPDATE "WorkspaceMember" wm SET "isClinician" = true
WHERE wm."role" = 'ADMIN'
  AND EXISTS (
    SELECT 1 FROM "ClinicalProcess" cp
    WHERE cp."workspaceId" = wm."workspaceId" AND cp."therapistId" = wm."userId"
  );

-- Garantía en la base de datos: un ASSISTANT nunca puede ser clínico.
ALTER TABLE "WorkspaceMember"
  ADD CONSTRAINT "WorkspaceMember_assistant_not_clinician"
  CHECK (NOT ("role" = 'ASSISTANT' AND "isClinician"));

-- Fin de la ventana de un proceso en pausa (no depende de updatedAt, que cualquier cambio mueve).
-- AlterTable
ALTER TABLE "ClinicalProcess" ADD COLUMN     "pausedAt" TIMESTAMP(3);

-- Procesos ya en pausa: la mejor aproximación disponible es su última modificación.
UPDATE "ClinicalProcess" SET "pausedAt" = "updatedAt" WHERE "status" = 'PAUSED';
