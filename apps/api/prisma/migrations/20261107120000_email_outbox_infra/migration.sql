-- N0 · Infraestructura común de avisos por email (bandeja de salida sobre NotificationDelivery).
-- Ningún email sale por esta migración: el envío lo hace la tarea programada de la API y solo con
-- STAFF_EMAIL_NOTIFICATIONS_ENABLED / PATIENT_EMAIL_NOTIFICATIONS_ENABLED = true (apagadas por defecto).

-- CreateEnum
CREATE TYPE "EmailTemplate" AS ENUM ('STAFF_APPOINTMENT_REQUEST', 'STAFF_PATIENT_CANCELLATION', 'STAFF_TASK_SUBMITTED', 'PATIENT_APPOINTMENT_REMINDER', 'PATIENT_REQUEST_ACCEPTED', 'PATIENT_REQUEST_REJECTED', 'PATIENT_APPOINTMENT_CHANGED', 'PATIENT_APPOINTMENT_CANCELLED');

-- Preferencias: único por espacio (antes userId y patientId eran únicos globales: un usuario en dos
-- espacios tenía una sola preferencia). Las filas existentes se conservan tal cual: con el único
-- global no puede haber duplicados por (workspaceId, userId) ni (workspaceId, patientId).
-- DropIndex
DROP INDEX "NotificationPreference_patientId_key";

-- DropIndex
DROP INDEX "NotificationPreference_userId_key";

-- AlterTable
ALTER TABLE "NotificationPreference" ADD COLUMN     "emailAppointmentRequests" BOOLEAN,
ADD COLUMN     "emailPatientCancellations" BOOLEAN,
ADD COLUMN     "emailTaskSubmitted" BOOLEAN;

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_workspaceId_userId_key" ON "NotificationPreference"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_workspaceId_patientId_key" ON "NotificationPreference"("workspaceId", "patientId");

-- Entregas: workspaceId (se rellena desde su Notification antes de exigirlo), plantilla, ventana de
-- envío, caducidad, intentos y reserva de la pasada.
-- AlterTable
ALTER TABLE "NotificationDelivery" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimToken" TEXT,
ADD COLUMN     "claimedUntil" TIMESTAMP(3),
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "template" "EmailTemplate",
ADD COLUMN     "workspaceId" TEXT;

UPDATE "NotificationDelivery" d
SET "workspaceId" = n."workspaceId"
FROM "Notification" n
WHERE n."id" = d."notificationId";

ALTER TABLE "NotificationDelivery" ALTER COLUMN "workspaceId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "NotificationDelivery_channel_status_scheduledAt_idx" ON "NotificationDelivery"("channel", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_workspaceId_channel_status_idx" ON "NotificationDelivery"("workspaceId", "channel", "status");
