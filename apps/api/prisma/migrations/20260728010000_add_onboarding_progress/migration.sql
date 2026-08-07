ALTER TABLE "WorkspaceMember"
ADD COLUMN "onboardingStep" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3),
ADD COLUMN "onboardingDismissedAt" TIMESTAMP(3);
