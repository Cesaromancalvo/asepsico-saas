-- AlterTable
ALTER TABLE "PatientPortalAccount" ADD COLUMN     "pendingActivation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "portalTermsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "portalTermsVersion" TEXT,
ADD COLUMN     "privacyNoticeAcknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "privacyNoticeVersion" TEXT;

-- CreateTable
CREATE TABLE "PortalIntakeLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "professionalId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenEncrypted" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalIntakeLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalSignupRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "intakeLinkId" TEXT NOT NULL,
    "professionalId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "birthDate" TEXT NOT NULL,
    "privacyNoticeVersion" TEXT NOT NULL,
    "portalTermsVersion" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalSignupRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalActivationToken" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "portalAccountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalActivationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalIntakeLink_tokenHash_key" ON "PortalIntakeLink"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "PortalIntakeLink_workspaceId_professionalId_key" ON "PortalIntakeLink"("workspaceId", "professionalId");

-- CreateIndex
CREATE INDEX "PortalSignupRequest_workspaceId_professionalId_expiresAt_idx" ON "PortalSignupRequest"("workspaceId", "professionalId", "expiresAt");

-- CreateIndex
CREATE INDEX "PortalSignupRequest_expiresAt_idx" ON "PortalSignupRequest"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PortalActivationToken_tokenHash_key" ON "PortalActivationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PortalActivationToken_workspaceId_portalAccountId_idx" ON "PortalActivationToken"("workspaceId", "portalAccountId");

-- AddForeignKey
ALTER TABLE "PortalIntakeLink" ADD CONSTRAINT "PortalIntakeLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalIntakeLink" ADD CONSTRAINT "PortalIntakeLink_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalSignupRequest" ADD CONSTRAINT "PortalSignupRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalSignupRequest" ADD CONSTRAINT "PortalSignupRequest_intakeLinkId_fkey" FOREIGN KEY ("intakeLinkId") REFERENCES "PortalIntakeLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalSignupRequest" ADD CONSTRAINT "PortalSignupRequest_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalActivationToken" ADD CONSTRAINT "PortalActivationToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalActivationToken" ADD CONSTRAINT "PortalActivationToken_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalActivationToken" ADD CONSTRAINT "PortalActivationToken_portalAccountId_fkey" FOREIGN KEY ("portalAccountId") REFERENCES "PatientPortalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Una cuenta pendiente de activacion nunca puede estar activa a la vez (defensa en la BD).
ALTER TABLE "PatientPortalAccount" ADD CONSTRAINT "PatientPortalAccount_pending_not_active_check" CHECK (NOT ("pendingActivation" AND "isActive"));
