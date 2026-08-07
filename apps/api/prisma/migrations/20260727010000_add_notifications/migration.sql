CREATE TYPE "NotificationAudience" AS ENUM ('PROFESSIONAL','PATIENT');
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP','EMAIL','SMS');
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING','SENT','READ','CANCELLED','FAILED');
CREATE TYPE "NotificationType" AS ENUM ('APPOINTMENT_REMINDER','TASK_DUE','CONSENT_EXPIRING','INVOICE_DUE','SYSTEM');
CREATE TABLE "NotificationPreference" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "patientId" TEXT, "userId" TEXT,
  "appointmentReminders" BOOLEAN NOT NULL DEFAULT true, "taskReminders" BOOLEAN NOT NULL DEFAULT true,
  "consentReminders" BOOLEAN NOT NULL DEFAULT true, "invoiceReminders" BOOLEAN NOT NULL DEFAULT true,
  "emailEnabled" BOOLEAN NOT NULL DEFAULT false, "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
  "reminderHoursBefore" INTEGER NOT NULL DEFAULT 24, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationPreference_patientId_key" ON "NotificationPreference"("patientId");
CREATE UNIQUE INDEX "NotificationPreference_userId_key" ON "NotificationPreference"("userId");
CREATE INDEX "NotificationPreference_workspaceId_idx" ON "NotificationPreference"("workspaceId");
CREATE TABLE "Notification" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "audience" "NotificationAudience" NOT NULL,
  "userId" TEXT, "patientId" TEXT, "type" "NotificationType" NOT NULL, "title" TEXT NOT NULL,
  "body" TEXT NOT NULL, "actionUrl" TEXT, "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
  "scheduledAt" TIMESTAMP(3) NOT NULL, "sentAt" TIMESTAMP(3), "readAt" TIMESTAMP(3), "dedupeKey" TEXT NOT NULL,
  "metadata" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
CREATE INDEX "Notification_workspaceId_audience_status_scheduledAt_idx" ON "Notification"("workspaceId","audience","status","scheduledAt");
CREATE INDEX "Notification_userId_status_createdAt_idx" ON "Notification"("userId","status","createdAt");
CREATE INDEX "Notification_patientId_status_createdAt_idx" ON "Notification"("patientId","status","createdAt");
CREATE TABLE "NotificationDelivery" (
  "id" TEXT NOT NULL, "notificationId" TEXT NOT NULL, "channel" "NotificationChannel" NOT NULL,
  "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING', "providerRef" TEXT, "attemptedAt" TIMESTAMP(3),
  "errorCode" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationDelivery_notificationId_channel_key" ON "NotificationDelivery"("notificationId","channel");
CREATE INDEX "NotificationDelivery_status_createdAt_idx" ON "NotificationDelivery"("status","createdAt");
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
