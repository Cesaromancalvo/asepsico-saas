-- CreateEnum
CREATE TYPE "WaitlistSituation" AS ENUM ('SELF_EMPLOYED', 'PRACTICE', 'STUDENT', 'OTHER');

-- CreateEnum
CREATE TYPE "WaitlistSource" AS ENUM ('INSTAGRAM', 'COLLEAGUE', 'PROFESSIONAL_COLLEGE', 'SEARCH_ENGINE', 'OTHER');

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailHash" TEXT,
    "situation" "WaitlistSituation",
    "tools" TEXT,
    "professionalsCount" INTEGER,
    "source" "WaitlistSource",
    "privacyPolicyVersion" TEXT NOT NULL,
    "privacyAcceptedAt" TIMESTAMP(3) NOT NULL,
    "commercialConsent" BOOLEAN NOT NULL DEFAULT false,
    "commercialConsentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_emailHash_key" ON "WaitlistEntry"("emailHash");

-- CreateIndex
CREATE INDEX "WaitlistEntry_deletedAt_createdAt_idx" ON "WaitlistEntry"("deletedAt", "createdAt");

