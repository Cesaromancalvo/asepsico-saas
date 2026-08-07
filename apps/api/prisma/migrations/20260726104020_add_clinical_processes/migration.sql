-- CreateEnum
CREATE TYPE "ClinicalProcessStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DISCHARGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TherapyModality" AS ENUM ('IN_PERSON', 'ONLINE', 'HYBRID');

-- CreateEnum
CREATE TYPE "SessionType" AS ENUM ('INDIVIDUAL', 'COUPLE', 'FAMILY', 'GROUP', 'FOLLOW_UP', 'ASSESSMENT');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "clinicalProcessId" TEXT,
ADD COLUMN     "internalSummary" TEXT,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "type" "SessionType" NOT NULL DEFAULT 'INDIVIDUAL',
ADD COLUMN     "videoCallUrl" TEXT;

-- CreateTable
CREATE TABLE "ClinicalProcess" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "therapistId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "consultationReason" TEXT,
    "goals" TEXT,
    "internalNotes" TEXT,
    "modality" "TherapyModality" NOT NULL DEFAULT 'IN_PERSON',
    "frequency" TEXT,
    "status" "ClinicalProcessStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicalProcess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicalProcess_workspaceId_status_idx" ON "ClinicalProcess"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "ClinicalProcess_patientId_status_idx" ON "ClinicalProcess"("patientId", "status");

-- CreateIndex
CREATE INDEX "ClinicalProcess_therapistId_status_idx" ON "ClinicalProcess"("therapistId", "status");

-- CreateIndex
CREATE INDEX "Session_clinicalProcessId_startsAt_idx" ON "Session"("clinicalProcessId", "startsAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_clinicalProcessId_fkey" FOREIGN KEY ("clinicalProcessId") REFERENCES "ClinicalProcess"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalProcess" ADD CONSTRAINT "ClinicalProcess_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalProcess" ADD CONSTRAINT "ClinicalProcess_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalProcess" ADD CONSTRAINT "ClinicalProcess_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
