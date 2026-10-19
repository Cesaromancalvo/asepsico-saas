-- H6 del acceso excepcional (docs/producto/acceso-excepcional.md): motivo cerrado de apertura de
-- procesos sobre historia ajena, registro de aperturas (sin texto) y tipo de aviso al titular.
-- Aditiva: columna nullable (procesos existentes en null), tabla y enums nuevos.

-- CreateEnum
CREATE TYPE "ProcessOpeningReason" AS ENUM ('SUBSTITUTION', 'TRANSFER_ON_LEAVE', 'PATIENT_REQUESTED_CHANGE', 'REFERRAL');

-- CreateEnum
CREATE TYPE "ProcessOpeningKind" AS ENUM ('OPENED', 'REACTIVATED');

-- CreateEnum
CREATE TYPE "OwnerReviewOutcome" AS ENUM ('CORRECT', 'INCIDENT');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'CLINICAL_ACCESS_NOTICE';

-- AlterTable
ALTER TABLE "ClinicalProcess" ADD COLUMN     "openingReasonCode" "ProcessOpeningReason";

-- CreateTable
CREATE TABLE "ClinicalProcessOpening" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicalProcessId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" "WorkspaceRole" NOT NULL,
    "targetTherapistId" TEXT NOT NULL,
    "kind" "ProcessOpeningKind" NOT NULL,
    "reasonCode" "ProcessOpeningReason" NOT NULL,
    "selfAssigned" BOOLEAN NOT NULL,
    "ownerCountAtCreation" INTEGER NOT NULL,
    "ownerReviewDueAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewOutcome" "OwnerReviewOutcome",
    "selfReview" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicalProcessOpening_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicalProcessOpening_workspaceId_createdAt_idx" ON "ClinicalProcessOpening"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ClinicalProcessOpening_workspaceId_patientId_idx" ON "ClinicalProcessOpening"("workspaceId", "patientId");

-- CreateIndex
CREATE INDEX "ClinicalProcessOpening_workspaceId_ownerReviewDueAt_idx" ON "ClinicalProcessOpening"("workspaceId", "ownerReviewDueAt");

-- AddForeignKey
ALTER TABLE "ClinicalProcessOpening" ADD CONSTRAINT "ClinicalProcessOpening_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
