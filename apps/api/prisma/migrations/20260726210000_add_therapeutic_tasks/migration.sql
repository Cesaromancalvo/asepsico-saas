-- Sprint 3: therapeutic tasks and between-session follow-up
CREATE TYPE "TherapeuticTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

CREATE TABLE "TherapeuticTask" (
  "id" TEXT NOT NULL,
  "patientId" TEXT NOT NULL,
  "therapyGoalId" TEXT,
  "sessionId" TEXT,
  "title" TEXT NOT NULL,
  "instructions" TEXT,
  "status" "TherapeuticTaskStatus" NOT NULL DEFAULT 'PENDING',
  "dueDate" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "patientFeedback" TEXT,
  "clinicianNotes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TherapeuticTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TherapeuticTask_patientId_status_idx" ON "TherapeuticTask"("patientId", "status");
CREATE INDEX "TherapeuticTask_patientId_dueDate_idx" ON "TherapeuticTask"("patientId", "dueDate");
CREATE INDEX "TherapeuticTask_therapyGoalId_idx" ON "TherapeuticTask"("therapyGoalId");
CREATE INDEX "TherapeuticTask_sessionId_idx" ON "TherapeuticTask"("sessionId");
ALTER TABLE "TherapeuticTask" ADD CONSTRAINT "TherapeuticTask_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TherapeuticTask" ADD CONSTRAINT "TherapeuticTask_therapyGoalId_fkey" FOREIGN KEY ("therapyGoalId") REFERENCES "TherapyGoal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TherapeuticTask" ADD CONSTRAINT "TherapeuticTask_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
