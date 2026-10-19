-- Historia B (veto de Argos): las notas internas de un proceso tienen autor. Al reasignar un proceso,
-- sus internalNotes (ya cifradas) se archivan aquí con su autor y el campo vivo queda vacío para el
-- nuevo profesional. Solo aditiva: no toca datos existentes (hasta hoy ningún proceso cambiaba de
-- profesional, así que todas las internalNotes vivas son de su therapistId actual).

-- CreateTable
CREATE TABLE "ClinicalProcessPrivateNote" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "processId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "notes" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'REASSIGNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicalProcessPrivateNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicalProcessPrivateNote_workspaceId_processId_idx" ON "ClinicalProcessPrivateNote"("workspaceId", "processId");

-- CreateIndex
CREATE INDEX "ClinicalProcessPrivateNote_authorId_idx" ON "ClinicalProcessPrivateNote"("authorId");

-- AddForeignKey
ALTER TABLE "ClinicalProcessPrivateNote" ADD CONSTRAINT "ClinicalProcessPrivateNote_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalProcessPrivateNote" ADD CONSTRAINT "ClinicalProcessPrivateNote_processId_fkey" FOREIGN KEY ("processId") REFERENCES "ClinicalProcess"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalProcessPrivateNote" ADD CONSTRAINT "ClinicalProcessPrivateNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
