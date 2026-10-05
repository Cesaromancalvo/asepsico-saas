-- Importación de pacientes (docs/producto/importacion-pacientes-csv.md).
-- Generada con prisma migrate diff (schema anterior -> actual), equivalente a migrate dev.

-- CreateEnum
CREATE TYPE "PatientImportStatus" AS ENUM ('UPLOADED', 'PREVIEWED', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'CANCELLED', 'EXPIRED', 'REVERTING', 'REVERTED');

-- CreateTable
CREATE TABLE "PatientImportJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "importerId" TEXT,
    "status" "PatientImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "format" TEXT NOT NULL,
    "payload" TEXT,
    "payloadExpiresAt" TIMESTAMP(3),
    "mapping" JSONB,
    "plan" JSONB,
    "errorReport" JSONB,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "revertedCount" INTEGER NOT NULL DEFAULT 0,
    "confirmedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "revertibleUntil" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientImportItem" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicalProcessId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientImportItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatientImportJob_workspaceId_importerId_createdAt_idx" ON "PatientImportJob"("workspaceId", "importerId", "createdAt");

-- CreateIndex
CREATE INDEX "PatientImportJob_status_payloadExpiresAt_idx" ON "PatientImportJob"("status", "payloadExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PatientImportItem_patientId_key" ON "PatientImportItem"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientImportItem_clinicalProcessId_key" ON "PatientImportItem"("clinicalProcessId");

-- CreateIndex
CREATE INDEX "PatientImportItem_workspaceId_jobId_idx" ON "PatientImportItem"("workspaceId", "jobId");

-- AddForeignKey
ALTER TABLE "PatientImportJob" ADD CONSTRAINT "PatientImportJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientImportJob" ADD CONSTRAINT "PatientImportJob_importerId_fkey" FOREIGN KEY ("importerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientImportItem" ADD CONSTRAINT "PatientImportItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientImportItem" ADD CONSTRAINT "PatientImportItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PatientImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientImportItem" ADD CONSTRAINT "PatientImportItem_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientImportItem" ADD CONSTRAINT "PatientImportItem_clinicalProcessId_fkey" FOREIGN KEY ("clinicalProcessId") REFERENCES "ClinicalProcess"("id") ON DELETE CASCADE ON UPDATE CASCADE;

