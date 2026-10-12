-- AlterEnum
ALTER TYPE "WaitlistSource" ADD VALUE 'NOT_SAID';

-- AlterTable
ALTER TABLE "WaitlistEntry" ADD COLUMN     "commercialConsentRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "commercialConsentRequestedAt" TIMESTAMP(3),
ADD COLUMN     "commercialConsentWithdrawnAt" TIMESTAMP(3);

