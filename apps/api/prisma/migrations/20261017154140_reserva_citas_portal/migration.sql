-- CreateEnum
CREATE TYPE "AvailabilityBlockReason" AS ENUM ('VACATION', 'TRAINING', 'PERSONAL', 'OTHER');

-- CreateEnum
CREATE TYPE "AppointmentRequestType" AS ENUM ('NEW', 'RESCHEDULE', 'CANCEL');

-- CreateEnum
CREATE TYPE "AppointmentRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AppointmentRejectionReason" AS ENUM ('SLOT_UNAVAILABLE', 'DISCUSS_IN_SESSION', 'CONTACT_PRACTICE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'APPOINTMENT_REQUEST';
ALTER TYPE "NotificationType" ADD VALUE 'APPOINTMENT_REQUEST_UPDATE';

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "timeZone" TEXT NOT NULL DEFAULT 'Europe/Madrid';

-- CreateTable
CREATE TABLE "TherapistAvailability" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "therapistId" TEXT NOT NULL,
    "portalBookingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sessionMinutes" INTEGER NOT NULL DEFAULT 50,
    "breakMinutes" INTEGER NOT NULL DEFAULT 10,
    "minNoticeHours" INTEGER NOT NULL DEFAULT 24,
    "maxHorizonDays" INTEGER NOT NULL DEFAULT 28,
    "cancelNoticeHours" INTEGER NOT NULL DEFAULT 24,
    "maxPendingPerPatient" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TherapistAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityWindow" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "therapistId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvailabilityWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityBlock" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "therapistId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" "AvailabilityBlockReason" NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvailabilityBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "therapistId" TEXT NOT NULL,
    "clinicalProcessId" TEXT,
    "sessionId" TEXT,
    "type" "AppointmentRequestType" NOT NULL,
    "status" "AppointmentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "heldStartsAt" TIMESTAMP(3),
    "requestedByAccountId" TEXT NOT NULL,
    "accessorType" "PortalAccessorType" NOT NULL,
    "rejectionReason" "AppointmentRejectionReason",
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TherapistAvailability_workspaceId_therapistId_key" ON "TherapistAvailability"("workspaceId", "therapistId");

-- CreateIndex
CREATE INDEX "AvailabilityWindow_workspaceId_therapistId_idx" ON "AvailabilityWindow"("workspaceId", "therapistId");

-- CreateIndex
CREATE INDEX "AvailabilityBlock_workspaceId_therapistId_startsAt_idx" ON "AvailabilityBlock"("workspaceId", "therapistId", "startsAt");

-- CreateIndex
CREATE INDEX "AppointmentRequest_workspaceId_status_expiresAt_idx" ON "AppointmentRequest"("workspaceId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "AppointmentRequest_workspaceId_patientId_status_idx" ON "AppointmentRequest"("workspaceId", "patientId", "status");

-- CreateIndex
CREATE INDEX "AppointmentRequest_workspaceId_therapistId_status_idx" ON "AppointmentRequest"("workspaceId", "therapistId", "status");

-- CreateIndex
CREATE INDEX "AppointmentRequest_requestedByAccountId_createdAt_idx" ON "AppointmentRequest"("requestedByAccountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentRequest_workspaceId_therapistId_heldStartsAt_key" ON "AppointmentRequest"("workspaceId", "therapistId", "heldStartsAt");

-- AddForeignKey
ALTER TABLE "TherapistAvailability" ADD CONSTRAINT "TherapistAvailability_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TherapistAvailability" ADD CONSTRAINT "TherapistAvailability_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityWindow" ADD CONSTRAINT "AvailabilityWindow_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityWindow" ADD CONSTRAINT "AvailabilityWindow_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityBlock" ADD CONSTRAINT "AvailabilityBlock_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityBlock" ADD CONSTRAINT "AvailabilityBlock_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentRequest" ADD CONSTRAINT "AppointmentRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentRequest" ADD CONSTRAINT "AppointmentRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentRequest" ADD CONSTRAINT "AppointmentRequest_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariantes en base de datos (Prisma no modela los CHECK; no afectan a `migrate diff`).
ALTER TABLE "AvailabilityWindow"
  ADD CONSTRAINT "AvailabilityWindow_range_check"
  CHECK ("weekday" BETWEEN 1 AND 7 AND "startMinute" >= 0 AND "endMinute" <= 1440 AND "startMinute" < "endMinute");

ALTER TABLE "AvailabilityBlock"
  ADD CONSTRAINT "AvailabilityBlock_range_check" CHECK ("startsAt" < "endsAt");

-- Solo una solicitud PENDING retiene hueco (heldStartsAt), y siempre el suyo.
ALTER TABLE "AppointmentRequest"
  ADD CONSTRAINT "AppointmentRequest_held_check"
  CHECK ("heldStartsAt" IS NULL OR ("status" = 'PENDING' AND "heldStartsAt" = "startsAt"));
