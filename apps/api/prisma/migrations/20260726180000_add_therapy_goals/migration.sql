CREATE TYPE "TherapyGoalStatus" AS ENUM ('ACTIVE', 'ACHIEVED', 'PAUSED', 'CANCELLED');

CREATE TABLE "TherapyGoal" (
  "id" TEXT NOT NULL,
  "patientId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "status" "TherapyGoalStatus" NOT NULL DEFAULT 'ACTIVE',
  "targetDate" TIMESTAMP(3),
  "achievedAt" TIMESTAMP(3),
  "priority" INTEGER NOT NULL DEFAULT 2,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TherapyGoal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TherapyGoal_patientId_status_idx" ON "TherapyGoal"("patientId", "status");
CREATE INDEX "TherapyGoal_patientId_priority_idx" ON "TherapyGoal"("patientId", "priority");
ALTER TABLE "TherapyGoal" ADD CONSTRAINT "TherapyGoal_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
