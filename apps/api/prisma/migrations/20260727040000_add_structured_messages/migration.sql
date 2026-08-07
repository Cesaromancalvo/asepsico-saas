CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'CLOSED', 'ARCHIVED');
CREATE TYPE "MessageSenderType" AS ENUM ('PROFESSIONAL', 'PATIENT');

CREATE TABLE "Conversation" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "patientId" TEXT NOT NULL,
  "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
  "patientCanReply" BOOLEAN NOT NULL DEFAULT true,
  "closedAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Message" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "senderType" "MessageSenderType" NOT NULL,
  "senderUserId" TEXT,
  "body" TEXT NOT NULL,
  "attachmentName" TEXT,
  "attachmentKey" TEXT,
  "mimeType" TEXT,
  "readByProfessionalAt" TIMESTAMP(3),
  "readByPatientAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Conversation_workspaceId_patientId_key" ON "Conversation"("workspaceId", "patientId");
CREATE INDEX "Conversation_workspaceId_status_updatedAt_idx" ON "Conversation"("workspaceId", "status", "updatedAt");
CREATE INDEX "Conversation_patientId_updatedAt_idx" ON "Conversation"("patientId", "updatedAt");
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
CREATE INDEX "Message_senderUserId_idx" ON "Message"("senderUserId");

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
