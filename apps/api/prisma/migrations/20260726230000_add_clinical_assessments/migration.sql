CREATE TABLE "ClinicalAssessment" (
  "id" TEXT NOT NULL,
  "patientId" TEXT NOT NULL,
  "scaleCode" TEXT NOT NULL,
  "scaleName" TEXT NOT NULL,
  "answers" JSONB NOT NULL,
  "totalScore" INTEGER NOT NULL,
  "severity" TEXT NOT NULL,
  "interpretation" TEXT NOT NULL,
  "riskFlag" BOOLEAN NOT NULL DEFAULT false,
  "clinicalNotes" TEXT,
  "administeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClinicalAssessment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ClinicalAssessment_patientId_administeredAt_idx" ON "ClinicalAssessment"("patientId", "administeredAt");
CREATE INDEX "ClinicalAssessment_patientId_scaleCode_idx" ON "ClinicalAssessment"("patientId", "scaleCode");
ALTER TABLE "ClinicalAssessment" ADD CONSTRAINT "ClinicalAssessment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
