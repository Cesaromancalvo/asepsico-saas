ALTER TYPE "TherapeuticTaskStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE "TherapeuticTaskStatus" ADD VALUE IF NOT EXISTS 'SUBMITTED';
ALTER TYPE "TherapeuticTaskStatus" ADD VALUE IF NOT EXISTS 'CHANGES_REQUESTED';

ALTER TABLE "TherapeuticTask"
  ADD COLUMN "assignedAt" TIMESTAMP(3),
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewComment" TEXT;

UPDATE "TherapeuticTask" SET "assignedAt" = "createdAt" WHERE "status" <> 'DRAFT' AND "assignedAt" IS NULL;
UPDATE "TherapeuticTask" SET "startedAt" = "updatedAt" WHERE "status" = 'IN_PROGRESS' AND "startedAt" IS NULL;
UPDATE "TherapeuticTask" SET "reviewedAt" = COALESCE("completedAt", "updatedAt") WHERE "status" = 'COMPLETED' AND "reviewedAt" IS NULL;

CREATE TABLE "TherapeuticTaskTemplate" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "instructions" TEXT,
  "category" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TherapeuticTaskTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TherapeuticTaskTemplate_workspaceId_isActive_idx" ON "TherapeuticTaskTemplate"("workspaceId", "isActive");
CREATE INDEX "TherapeuticTaskTemplate_workspaceId_title_idx" ON "TherapeuticTaskTemplate"("workspaceId", "title");
