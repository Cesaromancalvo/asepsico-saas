CREATE TABLE "PatientPortalAccount" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "patientId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
  "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "lastLoginAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PatientPortalAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PatientPortalAccount_patientId_key" ON "PatientPortalAccount"("patientId");
CREATE UNIQUE INDEX "PatientPortalAccount_email_key" ON "PatientPortalAccount"("email");
CREATE INDEX "PatientPortalAccount_workspaceId_isActive_idx" ON "PatientPortalAccount"("workspaceId", "isActive");
ALTER TABLE "PatientPortalAccount" ADD CONSTRAINT "PatientPortalAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PatientPortalAccount" ADD CONSTRAINT "PatientPortalAccount_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
