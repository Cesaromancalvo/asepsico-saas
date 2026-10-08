-- Atributo clínico del miembro (acceso clínico por proceso activo).
-- isClinician por sí solo no da acceso a ningún paciente: el contenido clínico exige además un
-- proceso ACTIVO con el paciente (o ser autor de un proceso cerrado, solo para lo suyo).

-- AlterTable
ALTER TABLE "WorkspaceMember" ADD COLUMN     "isClinician" BOOLEAN NOT NULL DEFAULT false;

-- Valores iniciales para los miembros existentes (isClinician solo es configurable en OWNER/ADMIN):
--  - THERAPIST: siempre clínico.
--  - OWNER y ADMIN: clínicos solo si ya son profesionales responsables de algún proceso del workspace.
--  - ASSISTANT: nunca clínico.
UPDATE "WorkspaceMember" SET "isClinician" = true WHERE "role" = 'THERAPIST';

UPDATE "WorkspaceMember" wm SET "isClinician" = true
WHERE wm."role" IN ('OWNER', 'ADMIN')
  AND EXISTS (
    SELECT 1 FROM "ClinicalProcess" cp
    WHERE cp."workspaceId" = wm."workspaceId" AND cp."therapistId" = wm."userId"
  );

-- Garantías en la base de datos: un ASSISTANT nunca es clínico y un THERAPIST siempre lo es.
ALTER TABLE "WorkspaceMember"
  ADD CONSTRAINT "WorkspaceMember_assistant_not_clinician"
  CHECK (NOT ("role" = 'ASSISTANT' AND "isClinician"));

ALTER TABLE "WorkspaceMember"
  ADD CONSTRAINT "WorkspaceMember_therapist_is_clinician"
  CHECK (NOT ("role" = 'THERAPIST' AND NOT "isClinician"));

-- Fin de la ventana de un proceso en pausa (no depende de updatedAt, que cualquier cambio mueve).
-- AlterTable
ALTER TABLE "ClinicalProcess" ADD COLUMN     "pausedAt" TIMESTAMP(3);

-- Procesos ya en pausa: la mejor aproximación disponible es su última modificación.
UPDATE "ClinicalProcess" SET "pausedAt" = "updatedAt" WHERE "status" = 'PAUSED';
