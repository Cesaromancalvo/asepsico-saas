-- Marcas de datos ficticios del espacio de demostración (db:seed-demo-workspace / db:purge-demo-workspace).
-- Aditiva: columnas con DEFAULT false (ningún dato existente queda marcado como demo).

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Patient_workspaceId_isDemo_idx" ON "Patient"("workspaceId", "isDemo");
