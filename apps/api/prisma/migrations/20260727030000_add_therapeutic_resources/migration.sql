CREATE TYPE "ResourceType" AS ENUM ('LINK', 'FILE');
CREATE TYPE "ResourceCategory" AS ENUM ('PSYCHOEDUCATION', 'EXERCISE', 'WORKSHEET', 'AUDIO', 'VIDEO', 'READING', 'OTHER');

CREATE TABLE "TherapeuticResource" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "type" "ResourceType" NOT NULL,
  "category" "ResourceCategory" NOT NULL DEFAULT 'OTHER',
  "url" TEXT,
  "fileName" TEXT,
  "mimeType" TEXT,
  "storageKey" TEXT,
  "createdById" TEXT NOT NULL,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TherapeuticResource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResourceShare" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "patientId" TEXT NOT NULL,
  "sharedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "ResourceShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResourceShare_resourceId_patientId_key" ON "ResourceShare"("resourceId", "patientId");
CREATE INDEX "TherapeuticResource_workspaceId_archivedAt_category_idx" ON "TherapeuticResource"("workspaceId", "archivedAt", "category");
CREATE INDEX "TherapeuticResource_workspaceId_title_idx" ON "TherapeuticResource"("workspaceId", "title");
CREATE INDEX "ResourceShare_workspaceId_patientId_revokedAt_idx" ON "ResourceShare"("workspaceId", "patientId", "revokedAt");

ALTER TABLE "TherapeuticResource" ADD CONSTRAINT "TherapeuticResource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TherapeuticResource" ADD CONSTRAINT "TherapeuticResource_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResourceShare" ADD CONSTRAINT "ResourceShare_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResourceShare" ADD CONSTRAINT "ResourceShare_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "TherapeuticResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceShare" ADD CONSTRAINT "ResourceShare_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
