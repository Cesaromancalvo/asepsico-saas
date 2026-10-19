-- Historia B: baja de un miembro del equipo y revalidación del access token.
-- La membresía no se borra nunca: pasa a REMOVED con fecha, autor y motivo de lista cerrada.

-- CreateEnum
CREATE TYPE "WorkspaceMemberStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "MemberRemovalReason" AS ENUM ('LEFT_PRACTICE', 'END_OF_COLLABORATION', 'LEAVE_OF_ABSENCE', 'OTHER');

-- AlterTable: tokenVersion va en el access token (claim tv); subirla invalida los tokens vivos.
ALTER TABLE "User" ADD COLUMN     "passwordChangedAt" TIMESTAMP(3),
ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "WorkspaceMember" ADD COLUMN     "removalReason" "MemberRemovalReason",
ADD COLUMN     "removedAt" TIMESTAMP(3),
ADD COLUMN     "removedById" TEXT,
ADD COLUMN     "status" "WorkspaceMemberStatus" NOT NULL DEFAULT 'ACTIVE';

-- Garantía en la BD: REMOVED si y solo si hay fecha de baja; un ACTIVE no lleva datos de baja.
ALTER TABLE "WorkspaceMember"
  ADD CONSTRAINT "WorkspaceMember_removed_has_date"
  CHECK (("status" = 'REMOVED') = ("removedAt" IS NOT NULL));

ALTER TABLE "WorkspaceMember"
  ADD CONSTRAINT "WorkspaceMember_active_without_removal_data"
  CHECK ("status" = 'REMOVED' OR ("removedById" IS NULL AND "removalReason" IS NULL));

-- CreateIndex
CREATE INDEX "WorkspaceMember_workspaceId_status_idx" ON "WorkspaceMember"("workspaceId", "status");
