CREATE TYPE "PatientDocumentType" AS ENUM ('CLINICAL','REFERRAL','ADMINISTRATIVE','EXTERNAL_REPORT','OTHER');
CREATE TYPE "ConsentType" AS ENUM ('DATA_PROCESSING','INFORMED_CONSENT','TELEPSYCHOLOGY','MINOR_GUARDIAN','COMMUNICATIONS','OTHER');
CREATE TYPE "ConsentStatus" AS ENUM ('PENDING','SIGNED','REVOKED','EXPIRED');
CREATE TYPE "ClinicalReportType" AS ENUM ('EVOLUTION','DISCHARGE','REFERRAL','CERTIFICATE','CUSTOM');
CREATE TYPE "ClinicalReportStatus" AS ENUM ('DRAFT','FINAL','VOID');

CREATE TABLE "PatientDocument" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "patientId" TEXT NOT NULL,
  "title" TEXT NOT NULL, "type" "PatientDocumentType" NOT NULL, "description" TEXT,
  "fileName" TEXT, "mimeType" TEXT, "storageKey" TEXT, "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PatientDocument_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ConsentRecord" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "patientId" TEXT NOT NULL,
  "type" "ConsentType" NOT NULL, "title" TEXT NOT NULL, "status" "ConsentStatus" NOT NULL DEFAULT 'PENDING',
  "signedAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3), "signedBy" TEXT, "notes" TEXT,
  "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ClinicalReport" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "patientId" TEXT NOT NULL,
  "title" TEXT NOT NULL, "type" "ClinicalReportType" NOT NULL,
  "status" "ClinicalReportStatus" NOT NULL DEFAULT 'DRAFT', "content" TEXT NOT NULL,
  "finalizedAt" TIMESTAMP(3), "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClinicalReport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PatientDocument_workspaceId_patientId_createdAt_idx" ON "PatientDocument"("workspaceId","patientId","createdAt");
CREATE INDEX "ConsentRecord_workspaceId_patientId_status_idx" ON "ConsentRecord"("workspaceId","patientId","status");
CREATE INDEX "ClinicalReport_workspaceId_patientId_status_idx" ON "ClinicalReport"("workspaceId","patientId","status");
ALTER TABLE "PatientDocument" ADD CONSTRAINT "PatientDocument_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PatientDocument" ADD CONSTRAINT "PatientDocument_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PatientDocument" ADD CONSTRAINT "PatientDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClinicalReport" ADD CONSTRAINT "ClinicalReport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClinicalReport" ADD CONSTRAINT "ClinicalReport_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClinicalReport" ADD CONSTRAINT "ClinicalReport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
