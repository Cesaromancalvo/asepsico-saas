CREATE TABLE "ClinicalHistory" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "reasonForConsultation" TEXT,
    "currentProblem" TEXT,
    "personalHistory" TEXT,
    "familyHistory" TEXT,
    "medicalHistory" TEXT,
    "currentMedication" TEXT,
    "primaryDiagnosis" TEXT,
    "riskFactors" TEXT,
    "protectiveFactors" TEXT,
    "clinicalObservations" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClinicalHistory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClinicalHistory_patientId_key" ON "ClinicalHistory"("patientId");
CREATE INDEX "ClinicalHistory_patientId_idx" ON "ClinicalHistory"("patientId");
ALTER TABLE "ClinicalHistory" ADD CONSTRAINT "ClinicalHistory_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
