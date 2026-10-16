-- Registro cerrado por invitación, invitación de miembros a un workspace existente y
-- aceptación versionada de las condiciones (piloto, contrato art. 28 RGPD y privacidad).
-- Los tokens de invitación solo se guardan como hash SHA-256.

-- CreateEnum
CREATE TYPE "LegalDocumentType" AS ENUM ('PILOT_TERMS', 'DPA_ART28', 'PRIVACY_PRODUCT');

-- CreateTable
CREATE TABLE "RegistrationInvite" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "usedByUserId" TEXT,
    "workspaceId" TEXT,

    CONSTRAINT "RegistrationInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceInvite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "isClinician" BOOLEAN NOT NULL,
    "invitedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "acceptedUserId" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "WorkspaceInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TermsAcceptance" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentType" "LegalDocumentType" NOT NULL,
    "version" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "TermsAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationInvite_tokenHash_key" ON "RegistrationInvite"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationInvite_usedByUserId_key" ON "RegistrationInvite"("usedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationInvite_workspaceId_key" ON "RegistrationInvite"("workspaceId");

-- CreateIndex
CREATE INDEX "RegistrationInvite_email_idx" ON "RegistrationInvite"("email");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInvite_tokenHash_key" ON "WorkspaceInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "WorkspaceInvite_workspaceId_createdAt_idx" ON "WorkspaceInvite"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkspaceInvite_email_idx" ON "WorkspaceInvite"("email");

-- CreateIndex
CREATE INDEX "TermsAcceptance_workspaceId_documentType_version_idx" ON "TermsAcceptance"("workspaceId", "documentType", "version");

-- CreateIndex
CREATE UNIQUE INDEX "TermsAcceptance_workspaceId_userId_documentType_version_tex_key" ON "TermsAcceptance"("workspaceId", "userId", "documentType", "version", "textHash");

-- AddForeignKey
ALTER TABLE "RegistrationInvite" ADD CONSTRAINT "RegistrationInvite_usedByUserId_fkey" FOREIGN KEY ("usedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationInvite" ADD CONSTRAINT "RegistrationInvite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvite" ADD CONSTRAINT "WorkspaceInvite_acceptedUserId_fkey" FOREIGN KEY ("acceptedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TermsAcceptance" ADD CONSTRAINT "TermsAcceptance_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TermsAcceptance" ADD CONSTRAINT "TermsAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Garantías en la base de datos para las invitaciones de miembros (las mismas que WorkspaceMember):
-- nunca se invita a nadie como OWNER, un THERAPIST siempre es clínico y un ASSISTANT nunca.
ALTER TABLE "WorkspaceInvite"
  ADD CONSTRAINT "WorkspaceInvite_not_owner"
  CHECK ("role" <> 'OWNER');

ALTER TABLE "WorkspaceInvite"
  ADD CONSTRAINT "WorkspaceInvite_assistant_not_clinician"
  CHECK (NOT ("role" = 'ASSISTANT' AND "isClinician"));

ALTER TABLE "WorkspaceInvite"
  ADD CONSTRAINT "WorkspaceInvite_therapist_is_clinician"
  CHECK (NOT ("role" = 'THERAPIST' AND NOT "isClinician"));

