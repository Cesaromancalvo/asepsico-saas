-- H1-H5 del acceso excepcional (docs/producto/acceso-excepcional.md): registro del acceso con
-- codigo cerrado y explicacion CIFRADA (por la app), revision del OWNER y contador agregado de
-- "Mi motivo no esta en la lista". Aditiva: tablas y enums nuevos.
-- H5 (motivos antiguos en claro en AuditLog.metadata.reason) NO se mueve aqui: el cifrado es de
-- la aplicacion. Tras desplegar: npm run db:migrate-exceptional-reasons (idempotente).

-- CreateEnum
CREATE TYPE "ExceptionalAccessReason" AS ENUM ('CONTINUITY_OF_CARE', 'VITAL_URGENCY', 'PATIENT_RIGHTS_REQUEST', 'LEGAL_REQUIREMENT', 'CLAIM_DEFENCE', 'CUSTODY', 'DATA_INCIDENT');

-- CreateTable
CREATE TABLE "ExceptionalAccessJustification" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" "WorkspaceRole" NOT NULL,
    "actorIsClinician" BOOLEAN NOT NULL,
    "reasonCode" "ExceptionalAccessReason" NOT NULL,
    "justification" TEXT NOT NULL,
    "clinicalTermWarningIgnored" BOOLEAN NOT NULL DEFAULT false,
    "authSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "retentionUntil" TIMESTAMP(3) NOT NULL,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "ownerCountAtCreation" INTEGER NOT NULL,
    "ownerReviewDueAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewOutcome" "OwnerReviewOutcome",
    "selfReview" BOOLEAN,
    "notificationDeferredAt" TIMESTAMP(3),
    "notificationDeferredReason" TEXT,
    "notificationReleasedAt" TIMESTAMP(3),
    "lastDeferralReminderAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "migratedFromAuditLogId" TEXT,

    CONSTRAINT "ExceptionalAccessJustification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExceptionalAccessReasonMiss" (
    "workspaceId" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExceptionalAccessReasonMiss_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExceptionalAccessJustification_migratedFromAuditLogId_key" ON "ExceptionalAccessJustification"("migratedFromAuditLogId");

-- CreateIndex
CREATE INDEX "ExceptionalAccessJustification_workspaceId_createdAt_idx" ON "ExceptionalAccessJustification"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ExceptionalAccessJustification_workspaceId_patientId_actorI_idx" ON "ExceptionalAccessJustification"("workspaceId", "patientId", "actorId");

-- CreateIndex
CREATE INDEX "ExceptionalAccessJustification_workspaceId_ownerReviewDueAt_idx" ON "ExceptionalAccessJustification"("workspaceId", "ownerReviewDueAt");

-- CreateIndex
CREATE INDEX "ExceptionalAccessJustification_authSessionId_idx" ON "ExceptionalAccessJustification"("authSessionId");

-- AddForeignKey
ALTER TABLE "ExceptionalAccessJustification" ADD CONSTRAINT "ExceptionalAccessJustification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExceptionalAccessReasonMiss" ADD CONSTRAINT "ExceptionalAccessReasonMiss_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

